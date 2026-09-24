# Boys of Chantilly dashboard (v1.3)

Tabs: Scoreboard (current + projected scores, current and projected median), Pecking order (median board, top 4, last place),
Pick 'em (Vegas-adjusted win chances + voting), Standings (current, head-to-head, median, "if man" best lineups), Waivers and trades.

## Layout
- `public/index.html`, `public/logo.png` – the page
- `netlify/functions/espn.mjs` – ESPN proxy at `/api/espn`
- `netlify/functions/week.mjs` – live/projected scores and win chances at `/api/week`
- `netlify/functions/ifman.mjs` – best-lineup standings at `/api/ifman` (finished weeks cached in Netlify Blobs)
- `netlify/functions/picks.mjs` – pick 'em votes at `/api/picks` (Netlify Blobs)
- `netlify/lib/espn.mjs`, `netlify/lib/model.mjs` – shared ESPN and projection code

## Projection model
ESPN player projections, scaled by each NFL team's Vegas implied total (from the spread and over/under on ESPN's NFL scoreboard)
relative to the week's average: factor = (implied / average)^0.6, clamped to 0.8–1.25. Defenses use the opponent's implied total, inverted.
Only the unplayed share of each game is projected. Win chance = normal CDF of the projected margin, with each starter's
uncertainty set to 0.65 x their remaining projection.

## Netlify settings
Build command blank, publish directory `public`. Environment variables `ESPN_S2` and `SWID` required.
