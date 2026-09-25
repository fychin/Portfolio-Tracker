# Portfolio Console

A rebalance tracker for goal-based investing across multiple accounts. Each
portfolio (e.g. a taxable brokerage account, a CPF account) is tracked
against its own target allocation, independently of the others — no single
blended number across everything you own.

No dependencies, no build step, no API keys. One Node file (`backend.js`)
serves the app and proxies two free, keyless public data sources (Yahoo
Finance for prices, marketcaps.site for market-cap weightings).

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

**Live prices** — "Refresh prices" pulls each holding's price
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

**Light/dark theme**, defaulting to light.

## Requirements

Node.js 18 or later (for built-in `fetch`). Nothing else — no `npm install`
is actually required, though Render's build step runs it harmlessly anyway.

## Running locally

```
node backend.js
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

Render sets `PORT` and a `RENDER` env var automatically — `backend.js`
detects `RENDER` and binds to `0.0.0.0` on its own, so no extra
configuration is needed for the app to actually be reachable.

**Getting your real data onto a deployed instance without committing it:**
use Render's **Secret Files** (Service → Environment tab) to add a file
named `seed-data.json` with your exported data as its content. It lands on
the service's filesystem at deploy time, same as if it sat next to
`backend.js` locally — the app bootstraps from it the first time any browser
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
   `seed-data.json` next to `backend.js` (or as a Render Secret File). A
   browser with no saved state yet will load it automatically on first
   visit. It's a one-time bootstrap, not a sync — once there's any saved
   state at all, `seed-data.json` is never consulted again for that browser.

## File overview

| File | Purpose |
|---|---|
| `portfolio-console.html` | The app — all UI and client-side logic |
| `backend.js` | Serves the app + three JSON APIs (`/api/quote`, `/api/base-weights`, `/api/seed-data`) |
| `package.json` | npm scripts and Node version requirement |
| `render.yaml` | Render Blueprint (optional — manual setup works too) |
| `.gitignore` | Excludes `seed-data.json` |
| `seed-data.json` | *(not committed)* your personal bootstrap data |

## Known limitations

- Won't fetch live data inside Claude's own artifact preview — Claude's
  sandbox blocks outside network requests by design. Run it via
  `backend.js` (locally or on Render) for live prices/weights to work.
- Yahoo Finance and marketcaps.site are both free, unofficial, keyless
  endpoints — not guaranteed stable, and can rate-limit or change shape
  without notice.
- Adding a third portfolio type with a genuinely different weighting scheme
  (not just 2-fund vs. 3-fund) would need code changes, not just new seed
  data.
