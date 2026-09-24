# Boys of Chantilly dashboard

Live dashboard for ESPN league 353576: live median board, matchups, standings with median record, and waivers/trades.

## Layout
- `public/index.html` – the page (add the league logo as `public/logo.png`)
- `netlify/functions/espn.mjs` – server-side proxy to ESPN, served at `/api/espn`
- `netlify.toml` – tells Netlify to publish `public/` and deploy the function

## Netlify settings
- Build command: leave blank. Publish directory: `public` (netlify.toml sets this).
- Environment variables: `ESPN_S2` and `SWID` (your ESPN login cookies; the league is private).
  Optional: `ESPN_SEASON` (default 2026), `ESPN_LEAGUE_ID` (default 353576).
- Deploy from GitHub (or `netlify deploy --prod`). Drag-and-drop deploys don't include functions.
