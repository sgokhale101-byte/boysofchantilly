// League history across every season ESPN has for this league.
import { getStore } from "@netlify/blobs";
import { SEASON, seasonLeague } from "./espn.mjs";
import { median, optimalPoints, parsePlayer, rosterOf } from "./model.mjs";
import { loadSeason } from "./season.mjs";

const r2 = (n) => Math.round((n || 0) * 100) / 100;
const store = () => getStore({ name: "cache", consistency: "strong" });
const rec = () => ({ w: 0, l: 0, t: 0 });
const decided = (g) => g.winner && g.winner !== "UNDECIDED";

function memberName(m) {
  if (!m) return "Unknown manager";
  const full = `${m.firstName || ""} ${m.lastName || ""}`.trim();
  return full || m.displayName || "Unknown manager";
}

// One season: every team's manager, final finish, official record, and records computed
// from the schedule (head-to-head and median, regular season only).
export async function seasonSummary(year) {
  const L = await seasonLeague(year, ["mTeam", "mSettings", "mMatchupScore", "mStandings", "mStatus"]);
  const reg = L.settings?.scheduleSettings?.matchupPeriodCount || 14;
  const members = {};
  (L.members || []).forEach((m) => (members[m.id] = { name: memberName(m) }));

  const teams = {};
  for (const t of L.teams || []) {
    const o = t.record?.overall || {};
    teams[t.id] = {
      teamId: t.id,
      memberId: t.primaryOwner || (t.owners || [])[0] || `team-${t.id}`,
      teamName: t.name || `${t.location || ""} ${t.nickname || ""}`.trim() || `Team ${t.id}`,
      abbrev: t.abbrev || "", logo: t.logo || null,
      finalRank: t.rankCalculatedFinal || t.rankFinal || null,
      seed: t.playoffSeed || null,
      official: { w: o.wins || 0, l: o.losses || 0, t: o.ties || 0 },
      h2h: rec(), median: rec(), regPF: 0, regPA: 0, regGames: 0, games: [],
    };
  }
  const byWeek = {};
  for (const g of L.schedule || []) if (g.matchupPeriodId <= reg) (byWeek[g.matchupPeriodId] ||= []).push(g);
  let weeksDone = 0;
  const doneWeeks = [];
  for (const [wk, games] of Object.entries(byWeek)) {
    if (!games.every(decided)) continue;
    weeksDone++; doneWeeks.push(Number(wk));
    const scores = [];
    for (const g of games) {
      if (!g.away) continue;
      const h = teams[g.home.teamId], a = teams[g.away.teamId]; if (!h || !a) continue;
      const hp = g.home.totalPoints || 0, ap = g.away.totalPoints || 0;
      h.regPF += hp; a.regPF += ap; h.regPA += ap; a.regPA += hp; h.regGames++; a.regGames++;
      scores.push([h, hp], [a, ap]);
      if (g.winner === "HOME") { h.h2h.w++; a.h2h.l++; } else if (g.winner === "AWAY") { a.h2h.w++; h.h2h.l++; } else { h.h2h.t++; a.h2h.t++; }
      const hr = g.winner === "HOME" ? "W" : g.winner === "AWAY" ? "L" : "T";
      h.games.push({ w: g.matchupPeriodId, pts: r2(hp), opp: a.teamId, oppPts: r2(ap), r: hr });
      a.games.push({ w: g.matchupPeriodId, pts: r2(ap), opp: h.teamId, oppPts: r2(hp), r: hr === "W" ? "L" : hr === "L" ? "W" : "T" });
    }
    const med = median(scores.map((x) => x[1]));
    scores.forEach(([t, p]) => (p > med ? t.median.w++ : p < med ? t.median.l++ : t.median.t++));
  }
  const list = Object.values(teams);
  list.forEach((t) => { t.regPF = r2(t.regPF); t.regPA = r2(t.regPA); });
  const games = (r) => r.w + r.l + r.t;
  const usesMedian = list.some((t) => games(t.official) > games(t.h2h));
  const complete = Number(year) < Number(SEASON) && weeksDone >= Object.keys(byWeek).length;
  return {
    year: Number(year), complete, usesMedian, regularSeasonWeeks: reg, doneWeeks: doneWeeks.sort((a, b) => a - b),
    slotCounts: L.settings?.rosterSettings?.lineupSlotCounts || null,
    previousSeasons: L.status?.previousSeasons || null,
    members, teams: list,
  };
}

export async function seasonSummaryCached(year) {
  const key = `hist/season/v4/${year}`;
  if (Number(year) < Number(SEASON)) {
    const hit = await store().get(key, { type: "json" }).catch(() => null);
    if (hit) return hit;
  }
  const s = await seasonSummary(year);
  if (s.complete) await store().setJSON(key, s).catch(() => {});
  return s;
}

// Which seasons exist: ESPN lists previous seasons on the current one.
export async function allSeasons() {
  const current = await seasonSummary(SEASON);
  let years = (current.previousSeasons || []).map(Number).filter((y) => y > 2000 && y < Number(SEASON));
  const past = await Promise.all(years.map((y) => seasonSummaryCached(y).catch(() => null)));
  return [...past.filter(Boolean), current].sort((a, b) => a.year - b.year);
}

// One finished week of any season: best-lineup scores per team and the week's top individual
// performances (every rostered player, starters and bench). Cached per week.
async function weekDetail(year, w, slotCounts) {
  const key = `hist/week/v2/${year}/w${w}`;
  const hit = await store().get(key, { type: "json" }).catch(() => null);
  if (hit) return hit;
  const L = await seasonLeague(year, ["mMatchupScore", "mScoreboard"], w);
  const rows = [], perf = [];
  for (const g of (L.schedule || []).filter((x) => x.matchupPeriodId === w)) {
    for (const [s, o] of [[g.home, g.away], [g.away, g.home]]) {
      if (!s) continue;
      const players = rosterOf(s).map((e) => parsePlayer(e, w));
      rows.push({
        teamId: s.teamId, oppId: o ? o.teamId : null,
        optimal: players.length && slotCounts ? Math.max(r2(s.totalPoints), optimalPoints(players, slotCounts)) : null,
        starters: players.filter((p) => p.slotId !== 20 && p.slotId !== 21).map((p) => ({ id: p.id, pos: p.pos, pts: r2(p.actual) })),
        roster: players.map((p) => p.id),
      });
      for (const p of players) if (p.actual > 0) perf.push({ name: p.name, pos: p.pos, pts: r2(p.actual), teamId: s.teamId, started: p.slotId !== 20 && p.slotId !== 21, week: w });
    }
  }
  const out = { rows, tops: perf.sort((a, b) => b.pts - a.pts).slice(0, 15) };
  await store().setJSON(key, out).catch(() => {});
  return out;
}

// Runs weekDetail over a season's finished weeks, stopping at the deadline (later calls pick up from the cache).
async function seasonWeeks(year, deadline) {
  const summary = await seasonSummaryCached(year);
  const weeks = Number(year) === Number(SEASON) ? summary.doneWeeks || [] : Array.from({ length: summary.regularSeasonWeeks }, (_, i) => i + 1);
  const results = {};
  const pending = [...weeks];
  while (pending.length && Date.now() < deadline) {
    const batch = pending.splice(0, 5);
    await Promise.all(batch.map(async (w) => { results[w] = await weekDetail(year, w, summary.slotCounts); }));
  }
  return { summary, weeks, results, done: Object.keys(results).length === weeks.length };
}

// "If man" results for one season: best lineups, head-to-head and median.
export async function seasonIfMan(year, deadline) {
  if (Number(year) === Number(SEASON)) {
    const s = await loadSeason();
    const weekly = {}, positions = {};
    s.weeks.forEach(({ week, teams }) => teams.forEach((t) => {
      if (t.optimal != null) (weekly[t.teamId] ||= {})[week] = t.optimal;
      for (const p of t.starters || []) { const P = (positions[t.teamId] ||= {}); P[p.pos || "?"] = r2((P[p.pos || "?"] || 0) + p.pts); }
    }));
    return { year: Number(year), complete: true, available: true, weekly, positions, teams: tally(s.weeks.map((w) => w.teams.map((t) => ({ teamId: t.teamId, oppId: t.oppId, optimal: t.optimal })))) };
  }
  const { summary, weeks, results, done } = await seasonWeeks(year, deadline);
  if (!summary.slotCounts) return { year: Number(year), complete: true, available: false, teams: {} };
  const all = weeks.map((w) => results[w]?.rows).filter(Boolean);
  const available = all.length > 0 && all.every((rows) => rows.length && rows.every((r) => r.optimal != null));
  // Best possible score for every team-week, for season-long start accuracy.
  const weekly = {}, positions = {};
  if (done && available) weeks.forEach((w) => (results[w]?.rows || []).forEach((r) => {
    if (r.optimal != null) (weekly[r.teamId] ||= {})[w] = r.optimal;
    for (const p of r.starters || []) { const P = (positions[r.teamId] ||= {}); P[p.pos || "?"] = r2((P[p.pos || "?"] || 0) + p.pts); }
  }));
  return { year: Number(year), complete: done, available: done ? available : null, weekly, positions, teams: done && available ? tally(all) : {} };
}

// Top individual performances for one season (finished weeks only).
export async function seasonPlayers(year, deadline) {
  const { weeks, results, done } = await seasonWeeks(year, deadline);
  const tops = weeks.flatMap((w) => results[w]?.tops || []).sort((a, b) => b.pts - a.pts).slice(0, 25);
  const available = done ? tops.length > 0 : null;
  return { year: Number(year), complete: done, available, tops };
}

function tally(weeks) {
  const teams = {};
  const t = (id) => (teams[id] ||= { h2h: rec(), median: rec() });
  for (const rows of weeks) {
    const byId = Object.fromEntries(rows.map((r) => [r.teamId, r]));
    const vals = rows.map((r) => r.optimal).filter((v) => v != null);
    const med = median(vals);
    for (const r of rows) {
      if (r.optimal == null) continue;
      const o = r.oppId != null ? byId[r.oppId] : null;
      if (o && o.optimal != null) { r.optimal > o.optimal ? t(r.teamId).h2h.w++ : r.optimal < o.optimal ? t(r.teamId).h2h.l++ : t(r.teamId).h2h.t++; }
      r.optimal > med ? t(r.teamId).median.w++ : r.optimal < med ? t(r.teamId).median.l++ : t(r.teamId).median.t++;
    }
  }
  return teams;
}

// Every team's end-of-season roster for one season, with season points (league scoring) and how
// each player was acquired. Finished seasons are cached.
export async function seasonRosters(year) {
  const key = `hist/roster/v1/${year}`;
  const past = Number(year) < Number(SEASON);
  if (past) { const hit = await store().get(key, { type: "json" }).catch(() => null); if (hit) return hit; }
  const L = await seasonLeague(year, ["mRoster", "mTeam"]);
  const teams = {};
  for (const t of L.teams || []) {
    teams[t.id] = (t.roster?.entries || []).map((e) => {
      const p = e.playerPoolEntry?.player || {};
      let pts = null;
      for (const st of p.stats || []) {
        if (st.statSourceId === 0 && st.scoringPeriodId === 0 && (st.seasonId == null || Number(st.seasonId) === Number(year)) && (st.statSplitTypeId == null || st.statSplitTypeId === 0)) pts = st.appliedTotal ?? pts;
      }
      return {
        name: p.fullName || `Player ${e.playerId}`, pos: POSITIONS[p.defaultPositionId] || "",
        acquired: e.acquisitionType || null, pts: pts == null ? null : r2(pts), slotId: e.lineupSlotId,
      };
    }).sort((a, b) => (ORDER[a.pos] ?? 9) - (ORDER[b.pos] ?? 9) || (b.pts ?? -1) - (a.pts ?? -1));
  }
  const out = { year: Number(year), teams, available: Object.values(teams).some((r) => r.length) };
  if (past && out.available) await store().setJSON(key, out).catch(() => {});
  return out;
}
const POSITIONS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
const ORDER = { QB: 0, RB: 1, WR: 2, TE: 3, "D/ST": 4, K: 5 };

// Playoff weeks for one past season: starters for every team playing in the winners bracket.
// ESPN can run a playoff round over more than one scoring period, so this goes period by period.
async function playoffWeeks(year, deadline) {
  const key = `hist/playoffs/v1/${year}`;
  const hit = await store().get(key, { type: "json" }).catch(() => null);
  if (hit) return hit;
  const S = await seasonLeague(year, ["mSettings", "mStatus"]);
  const reg = S.settings?.scheduleSettings?.matchupPeriodCount || 14;
  const map = S.settings?.scheduleSettings?.matchupPeriods || {};
  const final = S.status?.finalScoringPeriod || Math.max(reg, ...Object.values(map).flat().map(Number));
  const periodToMatchup = {};
  for (const [mp, sps] of Object.entries(map)) for (const sp of sps) periodToMatchup[Number(sp)] = Number(mp);
  const out = {};
  const periods = [];
  for (let sp = 1; sp <= final; sp++) { const mp = periodToMatchup[sp] ?? sp; if (mp > reg) periods.push({ sp, mp }); }
  for (let i = 0; i < periods.length; i += 4) {
    if (Date.now() > deadline) return null; // try again on the next call
    await Promise.all(periods.slice(i, i + 4).map(async ({ sp, mp }) => {
      const L = await seasonLeague(year, ["mMatchupScore", "mScoreboard"], sp);
      const rows = [];
      for (const g of (L.schedule || []).filter((x) => x.matchupPeriodId === mp && (!x.playoffTierType || x.playoffTierType === "WINNERS_BRACKET"))) {
        for (const side of [g.home, g.away]) {
          if (!side) continue;
          rows.push({ teamId: side.teamId, starters: rosterOf(side).map((e) => parsePlayer(e, sp)).filter((p) => p.slotId !== 20 && p.slotId !== 21).map((p) => ({ id: p.id, pts: r2(p.actual) })) });
        }
      }
      out[sp] = { rows };
    }));
  }
  await store().setJSON(key, out).catch(() => {});
  return out;
}

// Every trade in a season. Past seasons get a verdict: starting-lineup points each side got from the
// players it received, from the trade's week through the fantasy playoffs (winners bracket games).
export async function seasonTrades(year, deadline) {
  const Y = Number(year), past = Y < Number(SEASON);
  const key = `hist/trades/v2/${Y}`;
  if (past) { const hit = await store().get(key, { type: "json" }).catch(() => null); if (hit) return hit; }
  const summary = await seasonSummaryCached(Y);
  const lastPeriod = past ? summary.regularSeasonWeeks + 4 : Math.max(1, ...(summary.doneWeeks || [0])) + 1;
  // Transactions, one scoring period at a time (cached per period for past seasons).
  const trades = [];
  const periods = Array.from({ length: lastPeriod }, (_, i) => i + 1);
  let fetched = 0;
  for (let i = 0; i < periods.length && Date.now() < deadline; i += 6) {
    const batch = periods.slice(i, i + 6);
    const lists = await Promise.all(batch.map(async (pd) => {
      const pk = `hist/tx/v1/${Y}/p${pd}`;
      let list = past ? await store().get(pk, { type: "json" }).catch(() => null) : null;
      if (!list) {
        try {
          const L = await seasonLeague(Y, ["mTransactions2"], pd);
          list = (L.transactions || []).filter((t) => t.type === "TRADE_ACCEPT" && t.status === "EXECUTED").map((t) => ({
            id: t.id, period: t.scoringPeriodId ?? pd, date: t.processDate || t.proposedDate || 0,
            items: (t.items || []).filter((x) => x.type === "TRADE" || x.type === "ADD" || x.fromTeamId != null).map((x) => ({ playerId: x.playerId, from: x.fromTeamId, to: x.toTeamId })),
          }));
        } catch { list = []; }
        if (past) await store().setJSON(pk, list).catch(() => {});
      }
      return list;
    }));
    lists.flat().forEach((t) => trades.push(t)); fetched += batch.length;
  }
  const seen = new Set();
  const uniq = trades.filter((t) => (seen.has(t.id) ? false : seen.add(t.id))).sort((a, b) => a.date - b.date);
  const complete = fetched >= periods.length;

  // Players' starting points for their new team after the trade (needs weekly lineups).
  let weeks = null;
  if (past && complete && uniq.length) {
    const sw = await seasonWeeks(Y, deadline + 2500);
    const po = sw.done ? await playoffWeeks(Y, deadline + 3500).catch(() => ({})) : null;
    if (sw.done && po) weeks = { ...sw.results, ...po };
  }
  const names = await tradeNames(Y, [...new Set(uniq.flatMap((t) => t.items.map((x) => x.playerId)))]);
  const teamName = Object.fromEntries(summary.teams.map((t) => [t.teamId, t]));
  const out = uniq.map((t) => {
    const byTeam = {};
    for (const it of t.items) if (it.to != null && it.to >= 0) (byTeam[it.to] ||= []).push(it);
    const sides = Object.entries(byTeam).map(([teamId, items]) => {
      const tid = Number(teamId);
      const received = items.map((it) => {
        let pts = 0, starts = 0;
        if (weeks) for (const [w, wk] of Object.entries(weeks)) {
          if (Number(w) < t.period) continue;
          const row = wk.rows?.find((r) => r.teamId === tid);
          const st = row?.starters?.find((p) => p.id === it.playerId);
          if (st) { pts += st.pts; starts++; }
        }
        return { playerId: it.playerId, name: names[it.playerId]?.name || `Player ${it.playerId}`, pos: names[it.playerId]?.pos || "", pts: weeks ? r2(pts) : null, starts: weeks ? starts : null };
      });
      const team = teamName[tid];
      return { teamId: tid, teamName: team?.teamName || `Team ${tid}`, finalRank: past ? team?.finalRank ?? null : null, received, pts: weeks ? r2(received.reduce((a, x) => a + (x.pts || 0), 0)) : null };
    });
    let verdict = null;
    if (weeks && sides.length === 2) {
      const [a, b] = [...sides].sort((x, y) => y.pts - x.pts);
      const gap = a.pts - b.pts;
      verdict = gap < Math.max(15, 0.15 * Math.max(a.pts, 1)) ? { result: "even", gap: r2(gap) } : { result: "win", winner: a.teamId, loser: b.teamId, gap: r2(gap) };
    }
    return { id: t.id, year: Y, week: t.period, date: t.date, sides, verdict };
  });
  const result = { year: Y, complete: complete && (!past || !uniq.length || weeks != null), available: true, trades: out };
  if (past && result.complete) await store().setJSON(key, result).catch(() => {});
  return result;
}

const POS_NAMES = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
const NFL_DST = { 1: "Falcons", 2: "Bills", 3: "Bears", 4: "Bengals", 5: "Browns", 6: "Cowboys", 7: "Broncos", 8: "Lions", 9: "Packers", 10: "Titans",
  11: "Colts", 12: "Chiefs", 13: "Raiders", 14: "Rams", 15: "Dolphins", 16: "Vikings", 17: "Patriots", 18: "Saints", 19: "Giants", 20: "Jets",
  21: "Eagles", 22: "Cardinals", 23: "Steelers", 24: "Chargers", 25: "49ers", 26: "Seahawks", 27: "Buccaneers", 28: "Commanders", 29: "Panthers",
  30: "Jaguars", 33: "Ravens", 34: "Texans" };
async function tradeNames(year, ids) {
  const out = {};
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const data = await seasonLeague(year, ["kona_player_info"], 0, { "X-Fantasy-Filter": JSON.stringify({ players: { filterIds: { value: chunk }, limit: chunk.length } }) });
      for (const x of data.players || []) { const p = x.player || x; if (p?.id != null && p.fullName) out[p.id] = { name: p.fullName, pos: POS_NAMES[p.defaultPositionId] || "" }; }
    } catch {}
  }
  for (const id of ids) {
    if (out[id]) continue;
    const n = Math.abs(Number(id)) - 16000;
    if (NFL_DST[n]) { out[id] = { name: `${NFL_DST[n]} D/ST`, pos: "D/ST" }; continue; }
    try {
      const r = await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}`, { headers: { Accept: "application/json" } });
      if (r.ok) { const a = (await r.json()).athlete; if (a?.displayName) out[id] = { name: a.displayName, pos: a.position?.abbreviation || "" }; }
    } catch {}
  }
  return out;
}
