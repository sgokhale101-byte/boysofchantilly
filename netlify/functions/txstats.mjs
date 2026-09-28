// Bench and FAAB stats for the Transactions tab, served at /api/txstats.
//   twelfthMan: bench players who scored the most while benched (finished weeks)
//   deadWeight: bench players worth cutting (injured and out, or low scoring and barely rostered)
//   faab:       each team's balance, spend, and starting-lineup points per FAAB dollar
import { EspnError, espnFetch, leagueUrl, SEASON } from "../lib/espn.mjs";
import { POS } from "../lib/model.mjs";
import { loadSeason } from "../lib/season.mjs";
import { currentMoves, playerNames, startingBudget, outForSeason } from "../lib/tx.mjs";
import { gamesPlayed } from "../lib/halfppr.mjs";

const json = (status, obj, cache = "no-store") => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": cache },
});
const r2 = (n) => Math.round((n || 0) * 100) / 100;
// Weekly points below these (at the position) aren't worth a roster spot for long.
const FLOOR = { QB: 12, RB: 6, WR: 6, TE: 4, K: 5, "D/ST": 4 };
const OUT = { OUT: "out", INJURY_RESERVE: "on injured reserve", SUSPENSION: "suspended" };

function seasonTotal(p) {
  for (const s of p.stats || []) {
    if (s.statSourceId !== 0 || s.scoringPeriodId !== 0) continue;
    if (s.statSplitTypeId != null && s.statSplitTypeId !== 0) continue;
    if (s.seasonId != null && Number(s.seasonId) !== Number(SEASON)) continue;
    return s.appliedTotal ?? null;
  }
  return null;
}

export default async () => {
  let season, league, moves;
  try {
    [season, league] = await Promise.all([loadSeason(), espnFetch(leagueUrl(["mRoster", "mTeam", "mSettings", "mStatus"])).then(JSON.parse)]);
    moves = await currentMoves(league);
  } catch (e) {
    return json(e instanceof EspnError ? e.status : 500, { error: e.message || "Couldn't load roster stats." });
  }
  const weeks = season.weeks;

  // ---- 12th man ----
  const benchAgg = {};
  const startedBy = new Set(); // `${teamId}:${playerId}` ever started
  for (const { week, teams } of weeks) for (const t of teams) {
    (t.starters || []).forEach((p) => startedBy.add(`${t.teamId}:${p.id}`));
    for (const p of t.bench || []) {
      const k = `${t.teamId}:${p.id}`;
      const a = (benchAgg[k] ||= { teamId: t.teamId, id: p.id, name: p.name, pos: p.pos, pts: 0, weeks: 0, best: null });
      a.pts += p.pts; a.weeks++;
      if (!a.best || p.pts > a.best.pts) a.best = { week, pts: p.pts };
    }
  }
  const twelfthMan = Object.values(benchAgg).filter((a) => a.pts > 0).sort((a, b) => b.pts - a.pts).slice(0, 10)
    .map((a) => ({ ...a, pts: r2(a.pts), avg: r2(a.pts / Math.max(1, a.weeks)) }));

  // ---- dead weight ----
  const deadWeight = [];
  const irSlots = Number(league.settings?.rosterSettings?.lineupSlotCounts?.[21] || 0);
  const irOpen = {};
  for (const t of league.teams || []) irOpen[t.id] = irSlots - (t.roster?.entries || []).filter((e) => e.lineupSlotId === 21).length > 0;
  const injuredChecks = [];
  for (const t of league.teams || []) for (const e of t.roster?.entries || []) {
    if (e.lineupSlotId !== 20) continue; // bench only
    const p = e.playerPoolEntry?.player || {};
    const pos = POS[p.defaultPositionId] || "";
    const total = seasonTotal(p), gp = gamesPlayed(p, SEASON) || null;
    const avg = total != null && gp ? total / gp : null;
    const owned = Number(p.ownership?.percentOwned);
    const floor = FLOOR[pos];
    const status = OUT[p.injuryStatus];
    const never = !startedBy.has(`${t.id}:${p.id}`) && weeks.length >= 2;
    let reason = null, score = 0;
    if (status) {
      // Injured players only count if they're done for the year, or the team has an IR spot open.
      injuredChecks.push({ t, e, p, pos, avg, owned, open: irOpen[t.id] && p.injuryStatus !== "SUSPENSION" });
      continue;
    }
    else if (avg != null && floor && avg < floor && Number.isFinite(owned) && owned < 50) { reason = `Averaging ${avg.toFixed(1)} a game, rostered in only ${Math.round(owned)}% of ESPN leagues`; score = 2 + (50 - owned) / 100; }
    else if (never && avg != null && floor && avg < floor * 1.3) { reason = `Hasn't been started all season, averaging ${avg.toFixed(1)} a game`; score = 1; }
    if (reason) deadWeight.push({ teamId: t.id, name: p.fullName || `Player ${e.playerId}`, pos, avg: avg == null ? null : r2(avg), owned: Number.isFinite(owned) ? Math.round(owned) : null, reason, score });
  }
  const seasonOut = await Promise.all(injuredChecks.map((c) => outForSeason(c.p.id, SEASON)));
  injuredChecks.forEach((c, i) => {
    let reason = null;
    if (seasonOut[i]) reason = "Out for the season and still taking up a bench spot";
    else if (c.open) reason = "Injured with an IR spot open. Move him there to free up the bench spot";
    if (reason) deadWeight.push({ teamId: c.t.id, name: c.p.fullName || `Player ${c.e.playerId}`, pos: c.pos, avg: c.avg == null ? null : r2(c.avg), owned: Number.isFinite(c.owned) ? Math.round(c.owned) : null, reason, score: seasonOut[i] ? 3 : 2.5 });
  });
  deadWeight.sort((a, b) => b.score - a.score || (a.avg ?? 0) - (b.avg ?? 0));

  // ---- FAAB ----
  const acq = league.settings?.acquisitionSettings || {};
  const budget = acq.acquisitionBudget || 0;
  const usesFaab = budget > 0 && acq.isUsingAcquisitionBudget !== false;
  const buys = [];
  for (const m of moves) {
    if (m.type !== "WAIVER" && m.type !== "FREEAGENT") continue;
    for (const it of m.items) if (it.type === "ADD") buys.push({ teamId: m.teamId, playerId: it.playerId, bid: m.type === "WAIVER" ? m.bid : 0, period: m.period, date: m.date });
  }
  // Starting-lineup points for the buying team from the week of the pickup on.
  for (const b of buys) {
    let pts = 0, starts = 0, name = null, pos = "";
    for (const { week, teams } of weeks) {
      if (week < b.period) continue;
      const t = teams.find((x) => x.teamId === b.teamId);
      const p = t?.starters?.find((x) => x.id === b.playerId);
      if (p) { pts += p.pts; starts++; name ||= p.name; pos ||= p.pos; }
      const bp = t?.bench?.find((x) => x.id === b.playerId);
      if (bp) { name ||= bp.name; pos ||= bp.pos; }
    }
    Object.assign(b, { pts: r2(pts), starts, name, pos });
  }
  const missing = [...new Set(buys.filter((b) => !b.name).map((b) => b.playerId))];
  const names = await playerNames(missing).catch(() => ({}));
  buys.forEach((b) => { if (!b.name) { b.name = names[b.playerId]?.name || `Player ${b.playerId}`; b.pos ||= names[b.playerId]?.pos || ""; } });

  const faabTeams = (league.teams || []).map((t) => {
    const mine = buys.filter((b) => b.teamId === t.id);
    const paid = mine.filter((b) => b.bid > 0);
    const spentHere = paid.reduce((a, b) => a + b.bid, 0);
    const spent = t.transactionCounter?.acquisitionBudgetSpent ?? spentHere;
    const start = startingBudget(t, league.members, budget);
    const paidPts = paid.reduce((a, b) => a + b.pts, 0);
    const freePts = mine.filter((b) => b.bid === 0).reduce((a, b) => a + b.pts, 0);
    return { teamId: t.id, start, left: usesFaab ? start - spent : null, spent, paidPts: r2(paidPts), freePts: r2(freePts), perDollar: spentHere ? r2(paidPts / spentHere) : null, buys: mine.length };
  });
  const bestBuys = buys.filter((b) => b.bid > 0 && b.pts > 0).map((b) => ({ ...b, perDollar: r2(b.pts / b.bid) })).sort((a, b) => b.perDollar - a.perDollar || b.pts - a.pts).slice(0, 10);
  const freeFinds = buys.filter((b) => b.bid === 0 && b.pts > 0).sort((a, b) => b.pts - a.pts).slice(0, 5);

  return json(200, {
    weeks: weeks.map((w) => w.week), twelfthMan, deadWeight: deadWeight.slice(0, 12),
    faab: { budget: usesFaab ? budget : null, teams: faabTeams, bestBuys, freeFinds },
  }, "public, max-age=300");
};

export const config = { path: "/api/txstats" };
