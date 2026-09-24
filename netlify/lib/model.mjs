// Projection model and lineup math shared by the week and ifman functions.
import { espnFetch, leagueUrl, SEASON } from "./espn.mjs";

export const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
export const SLOT = { 0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP", 16: "D/ST", 17: "K", 20: "Bench", 21: "IR", 23: "FLEX" };
const NON_STARTER = new Set([20, 21]);
const SPREAD_K = 0.65; // player score SD as a share of remaining projection

// ---------- NFL games and Vegas lines (ESPN public scoreboard) ----------
export async function nflWeek(week) {
  const out = { byTeam: {}, avgImplied: null, oddsGames: 0, available: false };
  let j;
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${SEASON}&seasontype=2&week=${week}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return out;
    j = await r.json();
  } catch { return out; }
  const implied = [];
  for (const ev of j.events || []) {
    const c = ev.competitions?.[0]; if (!c) continue;
    const status = c.status || ev.status || {};
    const state = status.type?.state || "pre";
    const period = status.period ?? 0, clock = status.clock ?? 900;
    const frac = state === "pre" ? 1 : state === "post" ? 0 : period > 4 ? 0.05 : Math.min(1, Math.max(0, ((4 - period) * 900 + clock) / 3600));
    const comps = c.competitors || [];
    const totals = {};
    const o = (c.odds || [])[0];
    if (o && typeof o.overUnder === "number") {
      const ou = o.overUnder;
      const m = /^([A-Z]{2,4})\s+(-?\d+(?:\.\d+)?)$/.exec(String(o.details || "").trim());
      const s = m ? Math.abs(parseFloat(m[2])) : Math.abs(Number(o.spread) || 0);
      const home = comps.find((x) => x.homeAway === "home"), away = comps.find((x) => x.homeAway === "away");
      let fav = null;
      if (o.homeTeamOdds?.favorite) fav = home; else if (o.awayTeamOdds?.favorite) fav = away;
      else if (m) fav = comps.find((x) => x.team?.abbreviation === m[1]) || null;
      for (const cp of comps) {
        const t = !fav || !s ? ou / 2 : cp === fav ? (ou + s) / 2 : (ou - s) / 2;
        totals[cp.team?.id] = t; implied.push(t);
      }
    }
    for (const cp of comps) {
      const opp = comps.find((x) => x !== cp);
      out.byTeam[Number(cp.team?.id)] = {
        state, frac, abbr: cp.team?.abbreviation, oppAbbr: opp?.team?.abbreviation, home: cp.homeAway === "home",
        implied: totals[cp.team?.id] ?? null, oppImplied: opp ? totals[opp.team?.id] ?? null : null,
      };
    }
  }
  out.available = Object.keys(out.byTeam).length > 0;
  out.oddsGames = implied.length / 2;
  out.avgImplied = implied.length ? implied.reduce((a, b) => a + b, 0) / implied.length : null;
  return out;
}

function vegasFactor(pos, g, avg) {
  if (!g || !avg) return 1;
  let ratio;
  if (pos === "D/ST") { if (!g.oppImplied) return 1; ratio = avg / g.oppImplied; }
  else { if (!g.implied) return 1; ratio = g.implied / avg; }
  return Math.min(1.25, Math.max(0.8, ratio ** 0.6));
}

// ---------- Roster parsing ----------
export function rosterOf(side) {
  return side?.rosterForCurrentScoringPeriod?.entries || side?.rosterForMatchupPeriod?.entries || [];
}

export function parsePlayer(entry, week) {
  const pl = entry.playerPoolEntry?.player || {};
  let actual = null, proj = 0;
  for (const s of pl.stats || []) {
    if (s.scoringPeriodId !== week) continue;
    if (s.statSourceId === 0) actual = s.appliedTotal ?? actual;
    if (s.statSourceId === 1) proj = s.appliedTotal ?? proj;
  }
  if (actual == null) actual = entry.playerPoolEntry?.appliedStatTotal ?? 0;
  return {
    id: pl.id ?? entry.playerId, name: pl.fullName || `Player ${entry.playerId}`, pos: POS[pl.defaultPositionId] || "",
    proTeamId: pl.proTeamId, slotId: entry.lineupSlotId, slot: SLOT[entry.lineupSlotId] || "",
    eligible: pl.eligibleSlots || [], actual: actual || 0, espnProj: proj || 0,
  };
}

export const isStarter = (p) => !NON_STARTER.has(p.slotId);

// Best possible lineup from actual points. Fills the most restrictive slots first.
export function optimalPoints(players, lineupSlotCounts) {
  const slots = [];
  for (const [id, n] of Object.entries(lineupSlotCounts || {})) {
    const sid = Number(id);
    if (NON_STARTER.has(sid) || !n) continue;
    for (let i = 0; i < n; i++) slots.push(sid);
  }
  const elig = (sid) => players.filter((p) => p.eligible.includes(sid)).length;
  slots.sort((a, b) => elig(a) - elig(b));
  const used = new Set(); let total = 0;
  for (const sid of slots) {
    let best = null;
    for (const p of players) {
      if (used.has(p.id) || !p.eligible.includes(sid)) continue;
      if (!best || p.actual > best.actual) best = p;
    }
    if (best) { used.add(best.id); total += best.actual; }
  }
  return Math.round(total * 100) / 100;
}

// ---------- Probability ----------
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

export function median(arr) {
  const a = [...arr].sort((x, y) => x - y); if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const r2 = (n) => Math.round(n * 100) / 100;

// ---------- Full week computation ----------
export async function computeWeek(week) {
  const [raw, nfl] = await Promise.all([
    espnFetch(leagueUrl(["mMatchupScore", "mScoreboard", "mStatus"], week)),
    nflWeek(week),
  ]);
  const league = JSON.parse(raw);
  const games = (league.schedule || []).filter((g) => g.matchupPeriodId === week);

  const side = (s) => {
    if (!s) return null;
    const players = rosterOf(s).map((e) => parsePlayer(e, week));
    let remaining = 0, variance = 0;
    const starters = players.filter(isStarter).map((p) => {
      const g = nfl.byTeam[p.proTeamId];
      const proj = p.espnProj * vegasFactor(p.pos, g, nfl.avgImplied);
      let rem;
      if (!nfl.available) rem = p.actual > 0 ? 0 : proj;
      else if (!g) rem = 0; // bye week or no game found
      else rem = g.state === "post" ? 0 : g.state === "pre" ? proj : proj * g.frac;
      remaining += rem; variance += (SPREAD_K * rem) ** 2;
      return {
        name: p.name, pos: p.pos, slot: p.slot, actual: r2(p.actual), proj: r2(proj), remaining: r2(rem),
        game: g ? { state: g.state, opp: g.oppAbbr, home: g.home } : null,
      };
    });
    const current = s.totalPointsLive ?? s.totalPoints ?? players.filter(isStarter).reduce((a, p) => a + p.actual, 0);
    return { teamId: s.teamId, current: r2(current), projected: r2(current + remaining), sd: Math.sqrt(variance), starters };
  };

  const matchups = games.map((g) => {
    const home = side(g.home), away = side(g.away);
    if (home && away) {
      const sd = Math.sqrt(home.sd ** 2 + away.sd ** 2);
      const diff = home.projected - away.projected;
      const p = sd < 0.5 ? (diff > 0 ? 1 : diff < 0 ? 0 : 0.5) : phi(diff / sd);
      home.winProb = r2(p); away.winProb = r2(1 - p);
    }
    [home, away].forEach((x) => x && delete x.sd);
    return { id: g.id, winner: g.winner || "UNDECIDED", home, away };
  });

  const sides = matchups.flatMap((m) => [m.home, m.away]).filter(Boolean);
  return {
    week, currentWeek: league.status?.currentMatchupPeriod ?? null,
    medians: { current: r2(median(sides.map((s) => s.current))), projected: r2(median(sides.map((s) => s.projected))) },
    odds: { games: nfl.oddsGames, nflData: nfl.available },
    matchups,
  };
}
