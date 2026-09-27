# Portfolio Console

A rebalance tracker for goal-based investing across multiple accounts. Each
portfolio (e.g. a taxable brokerage account, a CPF account) is tracked
against its own target allocation, independently of the others — no single
blended number across everything you own.

No dependencies, no build step, no API keys. One Node file (`server.js`)
serves the app and proxies two free, keyless public data sources (Yahoo
Finance for prices, marketcaps.site for market-cap weightings).

## Project layout

```
server.js                    entry point — serves the app + APIs
public/
  index.html                 the app (all UI and client-side logic)
data/
  seed-data.example.json     committed template — copy to seed-data.json
  seed-data.json             (gitignored) your real data, not committed
package.json                 npm scripts, Node version requirement
render.yaml                  Render Blueprint (optional)
.gitignore
```

## Features

**Multi-portfolio tracking** — each portfolio has its own holdings, target
weighting, currency, and contribution log. Switching tabs never mixes data
across accounts.

**Two weighting modes, per portfolio:**
- *Tilt* — a 3-fund base weighting (Developed / Emerging Markets / Small-cap)
  plus a satellite tilt slider on the small-cap slice, for a factor-tilted
  strategy.
- *Simple* — a plain 2-fund Developed/EM market-cap split, no small-cap
  component and no tilt, for an account that just wants market weight.

**Live prices, no API key** — "Refresh prices" pulls each holding's price
from Yahoo Finance via the app's own backend (so the browser never hits
Yahoo directly, sidestepping the CORS restriction Yahoo's endpoints have).
Non-native-currency holdings convert automatically to the portfolio's own
reporting currency, with the FX rate looked up the same way. A fund name is
looked up automatically too. Every holding shows when it was priced; a
failed fetch is flagged in red, a currency conversion note in blue — the two
are visually distinct.

**Live market weighting** — "Refresh base weights" pulls current relative
market-cap weights straight from marketcaps.site's CSV export (same numbers
the site itself shows), computed for whichever weighting mode that
portfolio uses.

**Automatic refresh** — prices and base weights refresh on page load and on
every tab switch, in addition to their manual refresh buttons.

**Rebalance view** — a stacked ribbon (actual vs. target), a legend, and
delta chips per bucket, plus a one-line recommendation for which bucket to
direct your next contribution into. A portfolio in "simple" mode never shows
a small-cap row it has no way to hold.

**Contribution log** — record each DCA round by units bought, with an
optional price to compute cost.

**Import/Export (JSON)** — back up or move your full state (every
portfolio, holdings, settings, history) between devices.

**Local-only storage** — all data lives in the browser's `localStorage`.
Nothing is sent to or stored on the server, except the one-time bootstrap
described below.

**Git-friendly personal data** — the app ships with empty, generic default
portfolios. Real holdings live in `data/seed-data.json` (see below), which
you keep out of git entirely.

**Light/dark theme**, defaulting to light.

## Requirements

Node.js 18 or later (for built-in `fetch`). Nothing else — no `npm install`
is actually required, though Render's build step runs it harmlessly anyway.

## Running locally

```
node server.js
```

or

```
npm start
```

Then open **http://localhost:8787**. Leave the terminal open — it also logs
every request and upstream response, which is the first place to look if a
refresh isn't working.

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `HOST` | `127.0.0.1` (local) / `0.0.0.0` (on Render) | Bind address |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | unset (no auth) | Require HTTP Basic Auth on every request |

## Deploying to Render

**Option A — Blueprint.** Push this repo (with `render.yaml` included) to
GitHub/GitLab, then in Render: **New +** → **Blueprint** → point it at your
repo. It picks up the build/start commands automatically.

**Option B — manual Web Service.** **New +** → **Web Service** → connect
your repo, then set:
- **Build Command:** `npm install`
- **Start Command:** `npm start`

Render sets `PORT` and a `RENDER` env var automatically — `server.js`
detects `RENDER` and binds to `0.0.0.0` on its own, so no extra
configuration is needed for the app to actually be reachable.

**Getting your real data onto a deployed instance without committing it:**
use Render's **Secret Files** (Service → Environment tab) to add a file
with path `data/seed-data.json` and your exported data as its content. It
lands on the service's filesystem at deploy time, same as if it sat in
`data/` locally — the app bootstraps from it the first time any browser
opens the URL with no saved state yet.

**If this will be reachable from the public internet**, set
`BASIC_AUTH_USER` and `BASIC_AUTH_PASS` in the Environment tab. Without
them, anyone with the URL can use your instance as an anonymous Yahoo
Finance proxy, and can read `/api/seed-data` directly if you've uploaded
one.

## Getting your data in

1. Open the app, add holdings under each portfolio's ledger (Query symbol,
   Bucket, Units — Name and Price fill in via "Refresh prices").
2. **Data tools → Export data (JSON)** whenever you want a backup or to move
   to another device/browser.
3. To seed a fresh install (a new clone, a new browser, or a fresh Render
   deploy) without hand-typing everything again: save that export as
   `data/seed-data.json` (or as a Render Secret File — see above). A browser
   with no saved state yet loads it automatically on first visit. It's a
   one-time bootstrap, not a sync — once there's any saved state at all,
   `data/seed-data.json` is never consulted again for that browser.
   `data/seed-data.example.json` shows the expected shape.

## API reference

| Endpoint | Returns |
|---|---|
| `GET /api/quote?symbol=SWRD.L` | `{ price, currency, name }` from Yahoo Finance, or `{ error }` |
| `GET /api/base-weights` | `{ threeFund, twoFund, asOf }` market-cap weightings from marketcaps.site |
| `GET /api/seed-data` | Contents of `data/seed-data.json`, or 404 if absent |

## Known limitations

- Adding a third portfolio type with a genuinely different weighting scheme
  (not just 2-fund vs. 3-fund) would need code changes, not just new seed
  data.
