// Playoff Predictor: the rest of the regular-season schedule with a projected score for every team, every week.
//   This week: the live projection from the Scoreboard (actual lineups, ESPN's projection adjusted by Vegas, plus
//     whatever has already been scored).
//   Later weeks: each team's best lineup from its current roster, where every player is worth
//     his points per game this season (games he scored in while on any league roster), blended with ESPN's season
//     projection while the sample is small,
//     x 0 on his NFL team's bye (from ESPN's NFL schedule),
//     x his injury status for next week (ESPN's status is for this week's game, so it's a partial discount): suspended 0,
//       out 40%, doubtful 70%, questionable 95%; injured reserve = 0 for the next 3 weeks,
//     x Vegas for the weeks that already have lines.
//   Start %: when players are close, the one started in more ESPN leagues gets the lineup spot.
//   Kicker and defense: if the team's own is on bye or hurt, it streams one worth 85% of the league's average start there.
// Each team's spread (for win chances) is 65% of each starter's projection, like the Scoreboard.
import { espnFetch, leagueUrl } from "./espn.mjs";
import { computeWeek, median, nflWeek, optimalLineup, POS, vegasFactor } from "./model.mjs";
import { loadSeason } from "./season.mjs";

const r1 = (n) => Math.round((n || 0) * 10) / 10;
const SPREAD_K = 0.65;
const PRIOR_GAMES = 4;          // ESPN's season projection counts as this many games in the blend
const IR_WEEKS = 3;             // injured reserve: out this many more weeks
const INJ_NEXT = { SUSPENSION: 0, OUT: 0.4, DOUBTFUL: 0.7, QUESTIONABLE: 0.95 };

function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

export async function predict() {
  const [cur, rosterRaw] = await Promise.all([loadSeason(), espnFetch(leagueUrl(["mRoster", "mTeam", "mSettings", "mStatus"]))]);
  const L = cur.league, R = JSON.parse(rosterRaw);
  const reg = L.settings?.scheduleSettings?.matchupPeriodCount || 14;
  const slotCounts = L.settings?.rosterSettings?.lineupSlotCounts;
  const decided = (g) => g.winner && g.winner !== "UNDECIDED";
  const byWeek = {};
  for (const g of L.schedule || []) if (g.matchupPeriodId <= reg && g.home && g.away) (byWeek[g.matchupPeriodId] ||= []).push(g);
  const remaining = Object.keys(byWeek).map(Number).filter((w) => byWeek[w].some((g) => !decided(g))).sort((a, b) => a - b);
  if (!remaining.length) return { done: true, regWeeks: reg, weeks: [] };
  const first = remaining[0];

  // Points per game this season from the league's weekly rosters (league scoring)
  const games = {};
  for (const { teams } of cur.weeks) for (const t of teams) for (const p of t.all || []) {
    if (!p.pts) continue; const g = (games[p.id] ||= [0, 0]); g[0] += p.pts; g[1]++;
  }
  // Streamers for K and D/ST: 85% of the league's average starting score at the position this season
  const startSum = {};
  for (const { teams } of cur.weeks) for (const t of teams) for (const p of t.starters || []) { if (p.pos !== "K" && p.pos !== "D/ST") continue; const x = (startSum[p.pos] ||= [0, 0]); x[0] += p.pts; x[1]++; }
  const streamer = (pos, slot) => ({ id: `stream-${pos}`, name: `Streamer (${pos})`, pos, proTeamId: null, eligible: [slot], perGame: startSum[pos]?.[1] ? 0.85 * startSum[pos][0] / startSum[pos][1] : pos === "K" ? 7 : 6, injury: "ACTIVE", pct: 0, stream: true });
  // Current rosters
  const teams = {};
  for (const t of R.teams || []) {
    teams[t.id] = (t.roster?.entries || []).map((e) => {
      const pl = e.playerPoolEntry?.player || {};
      let seasonProj = null;
      for (const s of pl.stats || []) if (s.statSourceId === 1 && s.scoringPeriodId === 0 && (s.statSplitTypeId == null || s.statSplitTypeId === 0)) seasonProj = s.appliedTotal ?? seasonProj;
      const g = games[pl.id] || [0, 0];
      const avg = g[1] ? g[0] / g[1] : null, prior = seasonProj ? seasonProj / 17 : null;
      const perGame = avg == null ? prior ?? 0 : prior == null ? avg : (g[0] + PRIOR_GAMES * prior) / (g[1] + PRIOR_GAMES);
      return {
        id: pl.id ?? e.playerId, name: pl.fullName || `Player ${e.playerId}`, pos: POS[pl.defaultPositionId] || "",
        proTeamId: pl.proTeamId, eligible: pl.eligibleSlots || [], perGame,
        injury: pl.injuryStatus || (pl.injured ? "OUT" : "ACTIVE"),
        pct: Number.isFinite(pl.ownership?.percentStarted) ? pl.ownership.percentStarted : 50,
      };
    });
  }

  // NFL schedules (byes) and lines for every remaining week
  const later = remaining.filter((w) => w !== first);
  const [live, ...nfls] = await Promise.all([computeWeek(first).catch(() => null), ...later.map((w) => nflWeek(w))]);
  const nflBy = Object.fromEntries(later.map((w, i) => [w, nfls[i]]));

  const weeks = [];
  for (const w of remaining) {
    const proj = {}, sd = {}, lineups = {};
    if (w === first && live) {
      for (const m of live.matchups) for (const s of [m.home, m.away]) if (s) {
        proj[s.teamId] = r1(s.projected);
        sd[s.teamId] = Math.sqrt(s.starters.reduce((a, p) => a + (SPREAD_K * (p.remaining || 0)) ** 2, 0));
        lineups[s.teamId] = s.starters.map((p) => ({ name: p.name, pos: p.pos, proj: r1(p.proj) }));
      }
    } else {
      const nfl = nflBy[w] || { available: false, byTeam: {} };
      const ahead = w - first;
      for (const [tid, players] of Object.entries(teams)) {
        const vals = [...players, streamer("K", 17), streamer("D/ST", 16)].map((p) => {
          let v = p.perGame;
          if (p.stream) return { ...p, value: v, actual: v * 0.9 };
          if (nfl.available && !nfl.byTeam[p.proTeamId]) v = 0;                                   // bye
          if (p.injury === "INJURY_RESERVE" && ahead <= IR_WEEKS) v = 0;
          else if (ahead === 1 && INJ_NEXT[p.injury] != null) v *= INJ_NEXT[p.injury];         // next week only
          v *= vegasFactor(p.pos, nfl.byTeam?.[p.proTeamId], nfl.avgImplied);
          return { ...p, value: v, actual: v * (0.9 + 0.2 * (p.pct / 100)) };                      // start % breaks near ties
        });
        const lu = optimalLineup(vals, slotCounts);
        proj[tid] = r1(lu.reduce((a, x) => a + x.player.value, 0));
        sd[tid] = Math.sqrt(lu.reduce((a, x) => a + (SPREAD_K * x.player.value) ** 2, 0));
        lineups[tid] = lu.map((x) => ({ name: x.player.name, pos: x.player.pos, proj: r1(x.player.value) }));
      }
    }
    // win chances: head to head, and finishing above the projected median
    const ids = Object.keys(proj);
    const med = median(ids.map((t) => proj[t]));
    const games = byWeek[w].map((g) => {
      const h = g.home.teamId, a = g.away.teamId, s = Math.sqrt((sd[h] || 1) ** 2 + (sd[a] || 1) ** 2);
      return { home: h, away: a, winner: decided(g) ? g.winner : null, homeWin: Math.round(phi(((proj[h] || 0) - (proj[a] || 0)) / s) * 100) / 100 };
    });
    const medWin = Object.fromEntries(ids.map((t) => [t, Math.round(phi(((proj[t] || 0) - med) / Math.max(1, sd[t] || 1)) * 100) / 100]));
    weeks.push({ week: w, live: w === first && Boolean(live?.started), proj, median: r1(med), medWin, games, lineups });
  }
  return { done: false, regWeeks: reg, firstWeek: first, generatedAt: Date.now(), weeks };
}
