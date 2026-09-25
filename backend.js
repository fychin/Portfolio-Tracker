#!/usr/bin/env node
/**
 * backend.js — the Portfolio Console's local web app server.
 *
 * Serves the app itself (portfolio-console.html, expected in the same
 * folder as this file) and two small JSON APIs it calls:
 *
 *   GET /api/quote?symbol=SWRD.L
 *     -> { price, currency, name }  or  { error: "..." }
 *     Proxies Yahoo Finance's chart endpoint server-side. Browsers block
 *     this endpoint's cross-origin requests (Yahoo sends no CORS header),
 *     but that's a browser-only restriction — a Node process calling it
 *     directly has no such limit, and once the page and API are both
 *     served from this one process, the browser sees it as same-origin
 *     and never needs CORS at all.
 *
 *   GET /api/base-weights
 *     -> { threeFund: { developed, em, scv }, twoFund: { developed, em }, asOf }
 *     Computes both the "3 funds" (World / World Small Cap / Emerging
 *     Markets — for a small-cap-value tilt strategy) and "2 funds" (World /
 *     Emerging Markets only, no small-cap — for a plain market-cap split)
 *     weightings the same way marketcaps.site does: each index's cap
 *     divided by the relevant sum. Reads the raw numbers from
 *     marketcaps.site's own CSV export rather than scraping its HTML, since
 *     the CSV is a stable, documented format.
 *
 *   GET /api/seed-data
 *     -> the parsed contents of seed-data.json (next to this file), or 404
 *     if it doesn't exist. Lets the app bootstrap real holdings on a fresh
 *     install/browser without ever committing them to git — see the git
 *     workflow note further down.
 *
 * Usage:
 *   node backend.js            # http://localhost:8787
 *   PORT=3000 node backend.js  # or pick your own port
 *
 * Requires Node 18+ (built-in fetch). No dependencies. Keep this file and
 * portfolio-console.html in the same folder. Leave the terminal open while
 * using the app; Ctrl+C to stop.
 *
 * Host binding: binds to 127.0.0.1 (localhost-only) by default — not
 * reachable from other devices, just this machine. On Render (or anywhere
 * that sets a RENDER env var, which Render does automatically), it instead
 * binds to 0.0.0.0 so the platform's router can reach it. Override with
 * HOST=0.0.0.0 (or any address) if you need that locally too, e.g. to test
 * from your phone on the same network.
 *
 * Optional access control: if BASIC_AUTH_USER and BASIC_AUTH_PASS are both
 * set, every request (page and APIs) requires HTTP Basic Auth with those
 * credentials. Off by default — fine for local use, but worth turning on
 * for any deployment reachable from the public internet, since without it
 * anyone with the URL can use this as an anonymous Yahoo Finance proxy, and
 * can read seed-data.json's contents via /api/seed-data if one is present.
 *
 * Git workflow: portfolio-console.html ships with empty/generic default
 * portfolios (no personal holdings). To keep your real numbers out of the
 * repo, export your data from the app (Data tools → Export data (JSON)),
 * save it as seed-data.json next to this file, and add "seed-data.json" to
 * .gitignore. A brand-new browser/clone with no saved state yet will then
 * bootstrap from it automatically on first load; once there's any saved
 * state at all, it's never touched again — editing in the app going
 * forward, and re-exporting over seed-data.json, is a separate, manual step.
 * To get a seed-data.json onto a Render deploy without committing it,
 * use Render's "Secret Files" (service's Environment page) rather than git.
 *
 * Every request and upstream response is logged to this terminal (path
 * queried, the exact Yahoo/marketcaps.site URL called, the status code
 * that came back, and a truncated copy of the body) — check here first
 * if something's not updating: if a request never shows up in this log
 * when you click "Refresh" in the app, the browser isn't reaching this
 * server at all (wrong URL, or backend.js isn't actually running).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const AUTH_USER = process.env.BASIC_AUTH_USER || "";
const AUTH_PASS = process.env.BASIC_AUTH_PASS || "";
const HTML_PATH = path.join(__dirname, "portfolio-console.html");
const SEED_PATH = path.join(__dirname, "seed-data.json");
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

function log(){
  var args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ["[" + new Date().toISOString() + "]"].concat(args));
}

function truncate(str, n){
  str = String(str);
  return str.length > n ? str.slice(0, n) + "…(truncated)" : str;
}

// Optional HTTP Basic Auth, gated on BASIC_AUTH_USER/BASIC_AUTH_PASS both
// being set. Constant-time-ish comparison isn't attempted here — this is a
// lightweight deterrent for a personal tool, not a security boundary for
// anything sensitive. Use a real auth layer in front if that's needed.
function isAuthed(req){
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
async function fetchYahooName(symbol){
  // The chart endpoint doesn't reliably include a name for every symbol
  // (especially foreign-listed ETFs), so fall back to Yahoo's search
  // endpoint, which does — same no-auth deal as chart.
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
    const payload = {
      // "3 funds": World + World Small Cap + Emerging Markets — for a
      // portfolio that runs the small-cap-value satellite tilt.
      threeFund: {
        developed: (world.cap / total3) * 100,
        em: (em.cap / total3) * 100,
        scv: (worldSmallCap.cap / total3) * 100,
      },
      // "2 funds": World + Emerging Markets only, no small-cap component —
      // for a plain market-cap split with no tilt.
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
// Serves a local seed-data.json next to this file, if present, so the app
// can bootstrap real holdings on a fresh install without them ever being
// committed to git. See portfolio-console.html's export button for the
// matching file shape — export once, save it here, gitignore it.
function handleSeedData(res) {
  fs.readFile(SEED_PATH, "utf8", function (err, data) {
    if (err) {
      log("[seed-data] none found (" + (err.code || err.message) + ") — that's fine if you're not using one");
      return sendJson(res, 404, { error: "No seed-data.json next to backend.js." });
    }
    try {
      const parsed = JSON.parse(data);
      log("[seed-data] serving seed-data.json (" + data.length + " bytes)");
      return sendJson(res, 200, parsed);
    } catch (e) {
      log("[seed-data] exists but isn't valid JSON:", e.message);
      return sendJson(res, 500, { error: "seed-data.json exists but isn't valid JSON: " + e.message });
    }
  });
}

// ---------- static HTML ----------
function serveHtml(res) {
  fs.readFile(HTML_PATH, function (err, data) {
    if (err) {
      return sendText(res, 500, "Couldn't read portfolio-console.html — make sure it's in the same folder as backend.js.\n\n" + err.message);
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

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
  if (reqUrl.pathname === "/" || reqUrl.pathname === "/index.html" || reqUrl.pathname === "/portfolio-console.html") {
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
