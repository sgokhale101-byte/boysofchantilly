# Boys of Chantilly dashboard (v1.2)

Tabs: Live (live score rank vs. median, top 4 and lowest scorer, matchups), Pick 'em, Standings, Waivers and trades.

## Layout
- `public/index.html` – the page; `public/logo.png` – league logo
- `netlify/functions/espn.mjs` – ESPN proxy at `/api/espn`
- `netlify/functions/picks.mjs` – pick 'em votes at `/api/picks`, stored in Netlify Blobs
- `netlify/lib/espn.mjs` – shared ESPN helpers
- `package.json` – installs `@netlify/blobs` for the picks function
- `netlify.toml` – publish `public/`, deploy functions

## Netlify settings
- Build command blank, publish directory `public`.
- Environment variables: `ESPN_S2`, `SWID` (required, private league).
- Pick 'em limits one vote per matchup per browser. Voting closes once either team scores.
