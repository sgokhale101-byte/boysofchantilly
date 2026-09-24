# Boys of Chantilly dashboard (v1.4.2)

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

## 1.3.1
- Standings: ESPN's official record already includes median games; If man now counts both head-to-head and median games. Games column added.
- Waivers and trades: player names resolved server-side at `/api/moves` (league player lookup, then ESPN athlete pages as a fallback).
- Team logos: ESPN logo, then `public/logos/<ABBREV>.png`, then initials.

## 1.3.2
- Phone layout: bottom tab bar, no sideways scrolling, compact tables (extra columns hidden on phones).
- "I'm ___" team picker next to the week selector, remembered per browser. Shows a summary card (record, standing,
  current and projected score, opponent and win chance) and highlights that team across every tab.

## 1.4
- Awards tab (`/api/awards`): per finished week, Biggest overperformer / letdown (actual vs. starters' ESPN projections),
  Manager of the week (fewest bench points left behind; ties go to the higher score), Noah of the week (highest-scoring
  head-to-head loss), Srimanth of the week (lowest-scoring head-to-head win), plus a season trophy case.
- Trophy icons are reusable SVG symbols in index.html: `<svg class="trophy"><use href="#tr-KEY"></use></svg>`,
  keys overperformer, letdown, manager, noah, srimanth.
- `netlify/lib/season.mjs` loads and caches every finished week (key `weeksum/v1/w<N>`); If man and Awards share it.

## 1.4.2
- Pre-game projections everywhere are the site's own (ESPN projection x Vegas factor). `/api/week` freezes each player's
  pre-game projection at kickoff (Blobs key `pregame/v1/w<N>`); Awards compare against those. Weeks the site never saw
  before kickoff are recomputed from the Vegas lines ESPN still lists (factor 1 if none). Season cache bumped to `weeksum/v2`.
- Pick 'em: after voting, win chance and projection are replaced by the vote split with a fill animation.
- Team defenses in Waivers and trades show as "<Team> D/ST" (ids 16000 + NFL team number).
- Scoreboard lineups ordered QB/RB/RB/WR/WR/TE/FLEX/DST/K. Tab renamed "Pecking Order". Games column removed from Standings.
