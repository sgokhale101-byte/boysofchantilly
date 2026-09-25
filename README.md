# Boys of Chantilly dashboard (v1.6.3)

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

## 1.4.3
- Phone tab bar shows "Pecking Order" on two lines.
- Award names: Overperformer, Letdown, Manager of the Week, Noah of the Week, Srimanth of the Week.
- Icons: Overperformer green trophy, Letdown red trophy, Noah crying baby, Srimanth four-leaf clover.

## 1.4.4
- "I'm ___" summary lists the team's trophies with what each means and the weeks won.
- Trophy case shows the weeks for each trophy (e.g. "Wk 1, 2").
- Weekly awards have a week dropdown (latest finished week by default, or All weeks).

## 1.5
- Story tab (`/api/story?week=N`): Team of the Week (best lineup from every player's actual points, rostered or free agent,
  owner = who rostered him that week, flags benched), plus trends: streak + last-3-week scoring vs. weekly median, and
  week-to-week swing (consistency). Team of the Week cached per finished week (`tow/v1/w<N>`).
- History tab (`/api/history`): manager profiles keyed by ESPN member id (current and former), average finish, points per game,
  championships, official / head-to-head / median / If man records, all time or by season; final standings by season.
  Past seasons cached (`hist/season/v1/<year>`); If man per past season cached week by week (`hist/ifman/v1/<year>/w<N>`).
  If man is unavailable for seasons where ESPN has no weekly lineups.
- Phone tab bar: Scores, Pecking Order, Pick 'em, Standings, More (Awards, Story, History, Waivers and trades).
- `netlify/lib/history.mjs`, `seasonUrl` / `seasonLeague` in `netlify/lib/espn.mjs` (seasons before 2018 use ESPN's leagueHistory endpoint).

## 1.5.1
- "Pecking Order" renamed "Food Chain" (#foodchain works as a link). Adds a Weekly pot: $12 to each week's high scorer
  (ties split), season winnings, and the live leader for the current week.
- "Waivers and trades" renamed "Transactions". Each move shows the team's FAAB left afterward (anchored on ESPN's
  spent total; bids from later moves added back). Finished periods cached (`tx/v1/p<N>`).
- Standings: dashed lines under rank 1 (regular-season leader) and under the last playoff spot (ESPN's playoff team count, default 8).
- Summary card shows when trophies are loading or failed to load.

## 1.6
- Power Rankings tab (`/api/power`): message board posts by the member named in POWER_AUTHOR (default "Saffa") that
  mention power rankings. "1. Team - blurb" lines become a ranked list; otherwise the post is shown as written. If nothing
  matches, the tab shows what ESPN returned (post types, authors) for troubleshooting.
- Trade block on Transactions (`/api/tradeblock`): reads each team's `tradeBlock` from ESPN; own players = on the block,
  other teams' players = interested.
- Draft tab (`/api/draft?season=YYYY`): picks by round or by manager, season points, and steals/busts by position rank
  (draft order, or price for auctions, vs. points finish; K and D/ST excluded; busts limited to the first four rounds).
  Finished seasons cached (`hist/draft/v1/<year>`).
- History: points allowed (per game in profiles, season totals in final standings). Season cache bumped to `hist/season/v2`.
- Story and the "I'm ___" picker use managers' first names instead of team names.
- Food Chain: the top 4 are The Sharks; teams below the median are labeled The Minnows.
- Manager of the Week shows start accuracy (points scored / best possible).

## 1.6.1
- Draft: player lookup now passes scoringPeriodId=0, with fallbacks (season players_wl list, D/ST ids, ESPN athlete pages).
  Board shows drafted and finished position ranks; the current season shows Drafted vs. Now instead of points. Cache `hist/draft/v2`.
- History: league rank for average finish, points per game, and points allowed per game (for the chosen scope).
- Power Rankings: [b]..[/b] bold and [i]..[/i] italic.
- Standings: dashed lines labeled "Regular season winner" and "Cancun on 3".
- Food Chain: dashed "Made the median" / "The Minnows" divider on the board; "The Sharks and Their Prey"; "Weekly Pot".

## 1.6.2
- Manager cleanup rules (MANAGER_RULES in index.html): team-to-manager assignments ("This Team Has Been Seized" 2018 and
  "Property of TMA" -> Jeremy S; "Dez Nuts" 2020 -> Mahat; "Minshew and The Crew" 2020 -> Rohit) and merges (both Vijay R's
  -> Vijay Rudraraju; both Vivek Iyer profiles). Team names match ignoring case and punctuation. Applies to History and Draft.
- Manager headshots in public/headshots/<firstname>.jpg (alexis, jeremy, sean, vivek, shreyas) replace the team logo
  circle everywhere, and appear on History profiles. Add a file and a HEADSHOTS entry for more.

## 1.6.3
- Draft rankings use half-PPR points computed from raw season stats (`netlify/lib/halfppr.mjs`): ESPN's public fantasy
  player data, with ESPN's public NFL stat pages as a backup. Finishes rank against every player at the position we have
  (drafted players plus the season's top 80 at QB/RB/WR/TE). Adds each manager's best steal and biggest bust
  (busts from rounds 1-6). Cache `hist/draft/v3`.
- Transactions: trade block moved to the top.
- Food Chain: the top half of the league (6 of 12) always makes the median, even with ties.
