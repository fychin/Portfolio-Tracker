#!/usr/bin/env node
/**
 * Portfolio Console — server.
 *
 * Serves public/index.html and three JSON APIs:
 *   GET /api/quote?symbol=SWRD.L   price/currency/name via Yahoo Finance
 *   GET /api/base-weights          market-cap weightings via marketcaps.site
 *   GET /api/seed-data             local data/seed-data.json, if present
 *
 * Both external calls happen server-side to sidestep Yahoo's/marketcaps
 * site's lack of CORS headers; since the page and APIs share an origin,
 * the browser never needs CORS at all. No dependencies — Node 18+ only
 * (built-in fetch). See README.md for setup, deployment, and data notes.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const AUTH_USER = process.env.BASIC_AUTH_USER || "";
const AUTH_PASS = process.env.BASIC_AUTH_PASS || "";
const HTML_PATH = path.join(__dirname, "public", "index.html");
const SEED_PATH = path.join(__dirname, "data", "seed-data.json");
const YAHOO_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(text);
}

function log() {
  var args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ["[" + new Date().toISOString() + "]"].concat(args));
}

function truncate(str, n) {
  str = String(str);
  return str.length > n ? str.slice(0, n) + "…(truncated)" : str;
}

// HTTP Basic Auth, active only when both env vars are set. A lightweight
// deterrent for a personal deployment, not a real security boundary.
function isAuthed(req) {
  if (!AUTH_USER && !AUTH_PASS) return true;
  var header = req.headers["authorization"] || "";
  if (!header.startsWith("Basic ")) return false;
  var decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch (e) {
    return false;
  }
  var idx = decoded.indexOf(":");
  var user = idx === -1 ? decoded : decoded.slice(0, idx);
  var pass = idx === -1 ? "" : decoded.slice(idx + 1);
  return user === AUTH_USER && pass === AUTH_PASS;
}

// ---------- /api/quote ----------

// Yahoo's chart endpoint often omits a fund's name (foreign ETFs
// especially); its search endpoint reliably has one, so use it as a fallback.
async function fetchYahooName(symbol) {
  var url = "https://query1.finance.yahoo.com/v1/finance/search?q=" + encodeURIComponent(symbol) + "&quotesCount=5&newsCount=0";
  try {
    log("[name-lookup] request", url);
    var upstream = await fetch(url, {
      headers: { "User-Agent": YAHOO_UA, "Accept": "application/json,text/plain,*/*" },
      signal: AbortSignal.timeout(8000),
    });
    log("[name-lookup] response status", upstream.status);
    if (!upstream.ok) return null;
    var data = await upstream.json();
    var quotes = data && data.quotes;
    if (!Array.isArray(quotes) || !quotes.length) return null;
    var exact = quotes.find(function (q) { return (q.symbol || "").toUpperCase() === symbol.toUpperCase(); });
    var match = exact || quotes[0];
    var name = (match && (match.longname || match.shortname)) || null;
    log("[name-lookup] resolved name for", symbol, "->", name);
    return name;
  } catch (e) {
    log("[name-lookup] failed for", symbol, "-", e && e.message ? e.message : String(e));
    return null;
  }
}

async function handleQuote(symbol, res) {
  if (!symbol) {
    log("[quote] rejected: missing symbol");
    return sendJson(res, 400, { error: "Missing ?symbol= parameter." });
  }
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=1d&interval=1d";
  log("[quote] request symbol=" + symbol, "->", url);
  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": YAHOO_UA, "Accept": "application/json,text/plain,*/*" },
      signal: AbortSignal.timeout(10000),
    });
    log("[quote] upstream status", upstream.status, "for", symbol);
    if (!upstream.ok) {
      const msg = "Yahoo returned HTTP " + upstream.status + " for \"" + symbol + "\"." + (upstream.status === 429 ? " (rate limited — wait a bit and retry)" : "");
      log("[quote] error:", msg);
      return sendJson(res, 200, { error: msg });
    }
    const data = await upstream.json();
    log("[quote] upstream body for", symbol, truncate(JSON.stringify(data), 800));
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    const err = data && data.chart && data.chart.error;
    if (err || !result || !result.meta || result.meta.regularMarketPrice === undefined) {
      const msg = (err && (err.description || err.code)) || ("No price returned for \"" + symbol + "\".");
      log("[quote] error:", msg);
      return sendJson(res, 200, { error: msg });
    }
    let name = result.meta.longName || result.meta.shortName || null;
    if (!name) {
      log("[quote] no name in chart meta for", symbol, "— trying search fallback");
      name = await fetchYahooName(symbol);
    }
    const payload = {
      price: result.meta.regularMarketPrice,
      currency: result.meta.currency || "USD",
      name: name,
    };
    log("[quote] responding for", symbol, JSON.stringify(payload));
    return sendJson(res, 200, payload);
  } catch (e) {
    const msg = e && e.name === "TimeoutError" ? "Request to Yahoo timed out." : ("Request to Yahoo failed: " + (e && e.message ? e.message : String(e)));
    log("[quote] exception for", symbol, "-", msg);
    return sendJson(res, 200, { error: msg });
  }
}

// ---------- /api/base-weights ----------

function parseCsvLine(line) {
  var result = [];
  var cur = "";
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

async function handleBaseWeights(res) {
  const url = "https://www.marketcaps.site/indices.csv";
  log("[base-weights] request", url);
  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": YAHOO_UA },
      signal: AbortSignal.timeout(10000),
    });
    log("[base-weights] upstream status", upstream.status);
    if (!upstream.ok) {
      const msg = "marketcaps.site returned HTTP " + upstream.status + ".";
      log("[base-weights] error:", msg);
      return sendJson(res, 200, { error: msg });
    }
    const text = await upstream.text();
    log("[base-weights] upstream body", truncate(text, 500));
    const rows = {};
    text.split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      var fields = parseCsvLine(line);
      if (fields.length < 3) return;
      var name = fields[0].trim().toLowerCase();
      var cap = parseFloat(fields[1]);
      if (!isFinite(cap)) return;
      rows[name] = { cap: cap, asOf: fields[2] };
    });
    var world = rows["world"];
    var worldSmallCap = rows["world small cap"];
    var em = rows["emerging markets"];
    if (!world || !worldSmallCap || !em) {
      const msg = "Couldn't find World / World Small Cap / Emerging Markets rows in the CSV — its format may have changed.";
      log("[base-weights] error:", msg);
      return sendJson(res, 200, { error: msg });
    }
    var total3 = world.cap + worldSmallCap.cap + em.cap;
    var total2 = world.cap + em.cap;
    // threeFund: World + World Small Cap + EM, for a small-cap-value tilt.
    // twoFund: World + EM only, no small-cap, for a plain market-cap split.
    const payload = {
      threeFund: {
        developed: (world.cap / total3) * 100,
        em: (em.cap / total3) * 100,
        scv: (worldSmallCap.cap / total3) * 100,
      },
      twoFund: {
        developed: (world.cap / total2) * 100,
        em: (em.cap / total2) * 100,
      },
      asOf: world.asOf,
    };
    log("[base-weights] responding", JSON.stringify(payload));
    return sendJson(res, 200, payload);
  } catch (e) {
    const msg = e && e.name === "TimeoutError" ? "Request to marketcaps.site timed out." : ("Request to marketcaps.site failed: " + (e && e.message ? e.message : String(e)));
    log("[base-weights] exception -", msg);
    return sendJson(res, 200, { error: msg });
  }
}

// ---------- /api/seed-data ----------

// Serves data/seed-data.json if present, so the app can bootstrap real
// holdings on a fresh install without committing them to git. See README.md.
function handleSeedData(res) {
  fs.readFile(SEED_PATH, "utf8", function (err, data) {
    if (err) {
      log("[seed-data] none found (" + (err.code || err.message) + ") — that's fine if you're not using one");
      return sendJson(res, 404, { error: "No data/seed-data.json found." });
    }
    try {
      const parsed = JSON.parse(data);
      log("[seed-data] serving data/seed-data.json (" + data.length + " bytes)");
      return sendJson(res, 200, parsed);
    } catch (e) {
      log("[seed-data] exists but isn't valid JSON:", e.message);
      return sendJson(res, 500, { error: "data/seed-data.json exists but isn't valid JSON: " + e.message });
    }
  });
}

// ---------- static HTML ----------

function serveHtml(res) {
  fs.readFile(HTML_PATH, function (err, data) {
    if (err) {
      return sendText(res, 500, "Couldn't read public/index.html.\n\n" + err.message);
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

// ---------- routing ----------

const server = http.createServer(function (req, res) {
  const reqUrl = new URL(req.url, "http://localhost:" + PORT);
  log("REQUEST", req.method, req.url);

  if (!isAuthed(req)) {
    log("REJECTED: failed Basic Auth");
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Portfolio Console"',
      "Content-Type": "text/plain",
    });
    return res.end("Authentication required.");
  }

  if (req.method !== "GET") {
    log("REJECTED: not GET");
    return sendText(res, 405, "Only GET is supported.");
  }

  if (reqUrl.pathname === "/api/quote") {
    return handleQuote(reqUrl.searchParams.get("symbol"), res);
  }
  if (reqUrl.pathname === "/api/base-weights") {
    return handleBaseWeights(res);
  }
  if (reqUrl.pathname === "/api/seed-data") {
    return handleSeedData(res);
  }
  if (reqUrl.pathname === "/" || reqUrl.pathname === "/index.html") {
    return serveHtml(res);
  }
  log("404 for", reqUrl.pathname);
  return sendText(res, 404, "Not found.");
});

server.listen(PORT, HOST, function () {
  var displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log("Portfolio Console running at http://" + displayHost + ":" + PORT + "/");
  if (HOST === "0.0.0.0") {
    console.log("Bound to 0.0.0.0 — reachable from outside this machine.");
    if (!AUTH_USER || !AUTH_PASS) {
      console.log("WARNING: no BASIC_AUTH_USER/BASIC_AUTH_PASS set — this instance has no access control.");
    }
  }
  console.log("Press Ctrl+C to stop.");
});
