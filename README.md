# Boys of Chantilly dashboard (v2.3.2)

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

## 1.6.4
- Draft: finished seasons rank by half-PPR points per game (min 6 games) as "PPG Rank"; the current season by total points.
  Top-5 steals/busts compare ESPN average draft position at the position (league draft slot if ADP is missing) with that
  rank, need a 3+ spot swing, and leave out keepers in finished seasons. The per-manager table is gone; the board tags
  picks instead (steal: finished a starter at the position and 6+ spots (QB/TE) or 12-15 spots (RB/WR) above where he went;
  bust: an early pick who finished that far below, or a top pick who played fewer than 6 games). Cache `hist/draft/v4`.
- History: Vijay's merged profile shows as "Wiwi RaRa" (Vijay Rudraraju underneath).
- Headshots added: Cameron, Nels, Noah, Srimanth, Adam.

## 1.6.5
- Draft: steals/busts (top 5 and board tags) compare where a player went at his position in this draft with his half-PPR
  PPG rank, for every season. Current season's PPG rank needs half the games played so far. Cache `hist/draft/v5`.
- History: "Wiwi RaRa" accounts merge into Vijay Rudraraju. Profiles add top 4 and bottom 4 finishes, best and worst
  regular-season week, and rivals (Cakewalk: best head-to-head record; Their Daddy: worst; Rival: closest to even,
  2+ games when possible). Season summaries now carry each team's game log. Cache `hist/season/v3`.
- "William" shows as "Will" everywhere.
- Headshots re-cropped wider at 320px, shown larger, tap to enlarge. Added Will and Saffa (matched by any word of the
  ESPN first or display name).

## 1.7
- Hall of Fame tab: top/bottom 10 weekly scores (all time or by year), top/bottom 10 season PPG (finished seasons),
  longest H2H win/loss streaks and median streaks (2022 on), following managers across seasons, and top individual player
  performances (league scoring, bench included) via `/api/history?part=players&season=Y`.
- `netlify/lib/history.mjs`: one cached week detail (`hist/week/v1/<year>/w<N>`) now feeds both If man and player records.
  Season summaries list finished weeks (`hist/season/v4`).
- Story: Record watch (this season's all-time scores, top-10 PPG pace, active streaks vs. the record).
- Section explanations moved into "Explain It" dropdowns.
- Draft: Round and Manager dropdowns; current season adds a Current column (total-points position rank).
- History: current managers' Cakewalk / Their Daddy / Rival are other current managers. 2018 "This Team Has Been Seized" -> Srimanth.
- "Trade Block" capitalized. Noah's photo replaced.

## 1.8
- Modes (header switch, remembered per browser; default Base). Each mode sets the phone tab bar; everything else is under More.
  Desktop shows every tab with the mode's tabs first. Switching jumps to the mode's first tab if the current tab isn't in it.
  - Sundays: Food Chain, Pick 'em, Scores
  - Base: Standings, Story, Awards, Pick 'em
  - Historian: History, Draft, Story
  Edit MODES in index.html to change them.
- Summary card shows the current matchup: both scores, projections, live/final status, and win chance.

## 1.8.1
- Phone tables: name columns truncate, number columns size to their content; season totals of 1,000+ show one decimal.
  Checked every tab at 360px and 390px, dark and light, with no clipped cells or sideways scrolling.
- Pick 'em: voting closes for the whole week at the first NFL kickoff (server-checked via ESPN's NFL scoreboard);
  everyone sees results after that. One vote per matchup per phone and per person ("I'm" pick). "Won" label replaces the check mark.
- Historian mode: History, Draft, Hall of Fame. Base and Historian hide the week picker and always show the current week.
- Light mode toggle (remembered per browser).

## 1.8.2
- Summary card shows a special message box by manager first name (SPECIAL_CARDS in index.html). Alexis: "Fuck Jeremy".

## 1.8.3
- Pick 'em: once voting locks, the big number is the vote split and the model's real win chance ("Real odds") sits below it
  (final score once the matchup ends).
- iPhone Safari: buttons drop the built-in styling and selected tabs, modes, and toggles set their text color explicitly,
  so selected labels stay visible in light mode.

## 1.8.4
- Home screen icon: public/icons (apple-touch-icon 180, 192, 512, favicon 32; 1024 master) and manifest.webmanifest
  (name "Boys of Chantilly", home screen label "Chantilly", opens full screen).
- Hall of Fame and Record watch rank seasons by median points per game.
- Summary card and Food Chain board show starters left to play (and live on the card) with projected points left.

## 1.9
- Eras: Plumber era (through 2021) and Median era (2022 on) in the History profile and Hall of Fame dropdowns; every list,
  record, and streak follows the chosen span.
- History: tap a team in Final standings or a profile's season list for its end-of-season roster
  (`/api/history?part=rosters&season=Y`, finished seasons cached `hist/roster/v1/<year>`).
- Big Brain award: made the median by starting a player under 60% started across ESPN who outscored the team's margin over
  the median. Start % is frozen per player at kickoff (`pregame-start/v1/w<N>`); earlier weeks use ESPN's current number
  and say so. Weekly data now carries starters (`weeksum/v3`).
- Power Rankings: checks for new posts every 10 minutes and badges the tab (or More) until opened; message board cache cut to 60s.

## 1.9.1
- History: the Records choice (all time, era, or season) stays selected while switching managers; every league season is listed.
- Hall of Fame: median streak lists only show for the Median era and 2022+ seasons (not All time).

## 1.9.2
- Start accuracy (points scored / best possible lineup): on the summary card for this week (live, `/api/week` now includes
  optimal + accuracy) and the season so far (from `/api/ifman`).
- Awards: Manager of the Week = best start accuracy; new Bench Blunder = worst (not awarded if every lineup is perfect).
- Transactions tab (`/api/txstats`): FAAB Tracker (left, spent, starting-lineup points from paid pickups per $, best buys,
  $0 free finds), 12th Man (most points scored while benched), Dead Weight (bench players out/on IR, low scoring and
  under 50% rostered, or never started and low scoring). Weekly data now carries bench players (`weeksum/v4`).
- `netlify/lib/tx.mjs`: shared transaction helpers used by moves and txstats.

## 1.9.3
- "The Estime Quotient": the FAAB Tracker's points-per-dollar metric.
- Manager of the Week must make the median (best start accuracy among teams above the weekly median).
- Weekly Recap at the top of Story (`/api/recap`), available once ESPN finalizes the week (usually early Tuesday), with a
  New badge: your week (matchup, median, start accuracy, best starter, biggest dud, standings move, next matchup preview),
  around the league (high and low score and pot, median line, closest game, biggest blowout, biggest upset by projection,
  crowd pick'em accuracy), the week's awards, and record-book entries.

## 1.9.4
- The Weekly Recap moved into the "I'm ___" summary card: before the current week's first kickoff, the card shows last week's
  recap (your week with a next-matchup preview, around the league, awards, record books) instead of the matchup, and switches
  to the live matchup once games start. Removed from the Story tab, along with its badge.

## 1.9.5
- Scoreboard shows each team's live start accuracy.
- New Waivers tab holds the weekly adds/drops/trades feed; Transactions keeps Trade Block, FAAB Tracker, 12th Man, Dead Weight.
- FAAB: starting budgets by manager (FAAB_START in netlify/lib/tx.mjs: Vivek, Cameron, Srimanth $110), also used for FAAB-left
  on each move. Tracker table shows left and spent only. Best buys skip pickups with no starting-lineup points; up to 10.
- 12th Man shows bench points per week benched.
- Dead Weight: injured players only when out for the season (ESPN injury report: return date after the season or season-ending
  notes) or when the team has an open IR spot.

## 1.9.6
- Season-long start accuracy (points scored / best possible lineup, summed over finished weeks):
  - Standings "Accuracy" view: accuracy, points left on bench, perfect weeks, best/worst week (`/api/ifman` now returns weekly
    actual + best lineup).
  - History profiles: accuracy for all time, an era, or a season, with league rank, perfect weeks, and bench points left
    (`/api/history?part=ifman` now returns weekly best lineups).
  - Hall of Fame: most and least accurate seasons (finished seasons with 6+ weeks of lineup data).

## 2.0
- Luck index (actual H2H wins minus expected wins from the weekly all-play record), with bad beats (losses above the weekly
  median) and lucky wins (wins below it): Standings "Luck" view (this season), History profiles (any span, league rank,
  all-play record), Hall of Fame (luckiest/unluckiest seasons, most bad beats, most lucky wins). Computed from game logs.
- Points by position pie charts: Standings (this season, from `/api/recap`) and History profiles (from weekly lineups;
  `/api/history?part=ifman` now returns positions). Weekly lineup cache now keeps starters (`hist/week/v2`).
- Trade Review tab (`/api/history?part=trades&season=Y`): every trade; finished seasons get a verdict from starting-lineup
  points each side got from the players it received, trade week through the end of the regular season (even if the gap is
  under 15 points or 15%), plus both teams' finishes. Past seasons cached (`hist/trades/v1`, `hist/tx/v1`).

## 2.0.1
- Trade Review verdicts now include fantasy playoff weeks (winners bracket games only, not consolation), period by period
  so multi-week playoff rounds work (`hist/playoffs/v1/<year>`). Trade cache bumped to `hist/trades/v2`, so past verdicts recompute.

## 2.1
- Six top-level tabs: Live, Pick 'em, Standings, The Week, Library, Power Rankings (GROUPS and TABS in index.html).
  - Live: Food Chain, Scoreboard. The Week: Story, Awards, Waivers, Transactions.
    Library: League History, Hall of Fame, Draft, Trade Review.
  - Each grouped tab has a sticky jump bar that scrolls to a section and highlights the one on screen; sections load as
    they come near the screen. Old links (#hof, #story, #foodchain, ...) open the right tab and scroll there.
- Modes updated: Sundays = Live, Pick 'em, The Week; Base = Standings, The Week, Pick 'em; Historian = Library, Standings.
- Nothing removed: every former tab is a section in its new home.

## 2.2
- Four tabs, no modes: Live (Food Chain, Scoreboard, Weekly Pot, The Sharks), The Week (Standings, Story, Awards,
  Transactions, Waivers), Social (Pick 'em, Power Rankings; the new-post badge is on Social), Library (Manager Profiles,
  Final Standings, Hall of Fame, Draft, Trade Review).
- Standings: H2H and "IF man..." renamed; Accuracy view removed (start accuracy lives on profiles as "Nth of N in the
  league"); Luck view drops the H2H column.
- The Week: "Record Watch" (only top-3 scores, top-3 paces, and streaks within 3 games of the record), "Trending", tap any
  trophy for what it is and how it was earned, Explain It on Best buys and Free finds, Dead Weight removed from view.
- Trade Block looks up names for players nobody rosters.
- Library: profile season list shown as compact chips; Final Standings is its own section; Hall of Fame drops "Most
  accurate seasons"; Trade Review hides team 0 (free agency) and names a winner on every trade by starting points
  ("Winning so far" this season). Trade cache `hist/trades/v3`.

## 2.2.1
- Record Watch: this season's scores and player games in an all-time top 10, top-10 (or bottom-10) PPG paces, and active
  streaks in the top 5 or within 3 games of it.
- Hall of Fame: Most and Least accurate seasons only for the Median era.
- Power Rankings: pages back through the whole message board (it mixes posts with every add/drop/trade notice), so every post shows.
- Recap card redesigned as tiles: result banner, Median / Start accuracy / Standings tiles, Next up mini-matchup,
  league tiles (High score + pot, Low score, Game of the Week, Biggest upset, Blowout, Pick 'em crowd), a swipeable row of
  award tiles (tap for details), and record-book cards. Best starter and Biggest dud removed.

## 2.2.2
- Record Watch adds non-scoring paces against the Hall of Fame lists: luck (luckiest/unluckiest), bad beats, lucky wins,
  and start accuracy (vs. Median-era seasons). Paces need 3+ games and project the current rate over a full regular season.
  Records already in the books are listed first.

## 2.2.3
- Record Watch mirrors the Hall of Fame list by list (same metrics and sizes; all time first, then the Median era):
  highest/lowest scores, best/worst median-PPG seasons, H2H and median win/loss streaks (top 5 or within 3 games), luckiest/
  unluckiest seasons, most bad beats / lucky wins, most/least accurate (Median era), and best player performances.
  "In the books" = on a list now; "On pace" = projected onto one (3+ games, full regular season).

## 2.2.4
- Record Watch grouped like the Hall of Fame: All time and Median era sections, one card per list, entries ranked, with
  "On pace" tags. Luck, bad beats, lucky wins, and start accuracy wait until 7 games played.
- Power Rankings: every edition is its own entry (thread replies split out, named by their first line), Saffa's numbered
  posts count even without the word "power", and every version seen is archived (`power/archive/v1/<season>`) so edited
  posts keep their earlier versions. Dropdown shows title, date, and "(latest)".
- Jump bars with five sections use two rows on phones; chip text shrinks slightly at 360px.

## 2.3
- Record Watch: green "In the books" tags; records on both the all-time and Median-era lists go in a "Both" section with both ranks.
- Power Rankings: one edition per "Power Rankings after Week N" post (latest version of each), titled and dated.
- Manager Profiles: Favorite player (most weeks on the roster; tiebreak = starting points in that manager's wins;
  `/api/history?part=favorites&season=Y`, cached `hist/fav/v1`), All-play record as its own stat, bench points removed.
- Draft: keepers get a yellow Keeper tag (never steal/bust) and stay out of the top 5; players who played under 60% of the
  season aren't busts; tags sit on their own line; tap a player for his draft history in the league. Cache `hist/draft/v6`.
- Standings and Final Standings: tap any column header to sort (tap again to flip).
- Trade Review: includes week 0 (preseason) trades and trades upheld after league review, de-duplicates the same trade
  recorded twice; caches reset (`hist/trades/v4`, `hist/tx/v2`).

## 2.3.1
- Power Rankings: any post with "power rankings" in its title or opening lines counts, in any word order; the week comes from
  "Week N" / "Wk N" anywhere, or the post's date order if there's no number. If nothing matches, the tab lists Saffa's post
  titles exactly as ESPN returned them.
- Trade Review: also reads trades from the message board's activity feed (type 244 "traded", all pages, 2018+), merged with
  transaction records; a missing receiving team or trade week is worked out from the weekly rosters. Cache `hist/trades/v5`.
- Draft: small colored icons left of the name (▲ steal, ▼ bust, K keeper) with a legend; the player history popup is
  stacked (no sideways scrolling) and every Finished entry is filled (PPG rank, total-points rank, "Didn't play", or why it's unranked).

## 2.3.2
- Power Rankings: week numbers can be words ("After Week Two"); any post titled "power rankings" counts even from another account.
- Trade Review: a third source reads trades off the weekly rosters (players moving directly team-to-team in both directions
  the same week; draft picks vs. week 1 for preseason trades). The activity feed no longer depends on ESPN's trade message code,
  and 40 pages are checked. Duplicates across sources are merged. Cache `hist/trades/v6`.
