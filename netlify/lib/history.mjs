// League history across every season ESPN has for this league.
import { getStore } from "@netlify/blobs";
import { BASE, LEAGUE_ID, SEASON, espnFetch, seasonLeague } from "./espn.mjs";
import { isStarter, median, optimalPoints, parsePlayer, rosterOf } from "./model.mjs";
import { REC_WEIGHT } from "./halfppr.mjs";
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
  const key = `hist/week/v3/${year}/w${w}`;
  const hit = await store().get(key, { type: "json" }).catch(() => null);
  if (hit) return hit;
  const L = await seasonLeague(year, ["mMatchupScore", "mScoreboard"], w);
  const rows = [], perf = [], elig = {};
  for (const g of (L.schedule || []).filter((x) => x.matchupPeriodId === w)) {
    for (const [s, o] of [[g.home, g.away], [g.away, g.home]]) {
      if (!s) continue;
      const players = rosterOf(s).map((e) => parsePlayer(e, w));
      rows.push({
        teamId: s.teamId, oppId: o ? o.teamId : null,
        optimal: players.length && slotCounts ? Math.max(r2(s.totalPoints), optimalPoints(players, slotCounts)) : null,
        starters: players.filter((p) => p.slotId !== 20 && p.slotId !== 21).map((p) => ({ id: p.id, pos: p.pos, pts: r2(p.actual) })),
        roster: players.map((p) => p.id),
        // whole roster (starters, bench, IR) with points, for injury luck's best-lineup math
        lineup: players.filter((p) => p.id != null).map((p) => ({ id: p.id, pos: p.pos, pts: r2(p.actual), s: isStarter(p) ? 1 : 0 })),
      });
      for (const p of players) if (p.pos && !elig[p.pos] && p.eligible?.length) elig[p.pos] = p.eligible;
      for (const p of players) if (p.actual > 0) perf.push({ name: p.name, pos: p.pos, pts: r2(p.actual), teamId: s.teamId, started: p.slotId !== 20 && p.slotId !== 21, week: w });
    }
  }
  const out = { rows, tops: perf.sort((a, b) => b.pts - a.pts).slice(0, 15), elig };
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
  const key = `hist/roster/v2/${year}`;
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
        id: p.id ?? e.playerId, name: p.fullName || `Player ${e.playerId}`, pos: POSITIONS[p.defaultPositionId] || "",
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
  const key = `hist/trades/v8/${Y}`;
  if (past) { const hit = await store().get(key, { type: "json" }).catch(() => null); if (hit) return hit; }
  const summary = await seasonSummaryCached(Y);
  // Week 0 holds preseason trades; past seasons run through the last playoff week.
  const lastPeriod = past ? summary.regularSeasonWeeks + 5 : Math.max(1, ...(summary.doneWeeks || [0])) + 1;
  // Transactions, one scoring period at a time (cached per period for past seasons).
  const trades = [];
  const pickups = new Set(); // "playerId>teamId" for every waiver / free-agent add this season
  const periods = Array.from({ length: lastPeriod + 1 }, (_, i) => i);
  let fetched = 0;
  for (let i = 0; i < periods.length && Date.now() < deadline; i += 6) {
    const batch = periods.slice(i, i + 6);
    const lists = await Promise.all(batch.map(async (pd) => {
      const pk = `hist/tx/v3/${Y}/p${pd}`;
      let list = past ? await store().get(pk, { type: "json" }).catch(() => null) : null;
      if (!list) {
        try {
          const L = await seasonLeague(Y, ["mTransactions2"], pd);
          // Waiver / free-agent pickups, kept so roster moves from them are never mistaken for trades
          const adds = (L.transactions || []).filter((t) => (t.type === "WAIVER" || t.type === "FREEAGENT") && t.status === "EXECUTED")
            .flatMap((t) => (t.items || []).filter((x) => x.type === "ADD").map((x) => ({ playerId: x.playerId, teamId: t.teamId })));
          // Any executed trade record (accepted, or upheld after league review)
          list = (L.transactions || []).filter((t) => String(t.type || "").startsWith("TRADE") && t.type !== "TRADE_PROPOSAL" && t.type !== "TRADE_DECLINE" && t.type !== "TRADE_VETO" && t.status === "EXECUTED").map((t) => ({
            id: t.id, period: t.scoringPeriodId ?? pd, date: t.processDate || t.proposedDate || 0,
            items: (t.items || []).filter((x) => x.type === "TRADE" || x.type === "ADD" || x.fromTeamId != null).map((x) => ({ playerId: x.playerId, from: x.fromTeamId, to: x.toTeamId })),
          }));
          list.push({ id: `adds:${pd}`, addsOnly: true, period: pd, adds });
        } catch { list = []; }
        if (past) await store().setJSON(pk, list).catch(() => {});
      }
      return list;
    }));
    lists.flat().forEach((t) => { if (t.addsOnly) t.adds.forEach((a) => pickups.add(`${a.playerId}>${a.teamId}`)); else trades.push(t); }); fetched += batch.length;
  }
  // Second source: the message board's activity log ("X traded to Y"), which keeps older seasons.
  if (fetched >= periods.length) {
    try { const act = await activityTrades(Y); for (const t of act) trades.push(t); (act.pickups || []).forEach((k) => pickups.add(k)); } catch {}
  }
  // Only real players count (draft-pick trades and blank entries have no player id).
  const realPlayer = (id) => Number.isFinite(Number(id)) && (Number(id) > 0 || Number(id) <= -16001);
  for (const t of trades) t.items = (t.items || []).filter((x) => realPlayer(x.playerId));
  for (let i = trades.length - 1; i >= 0; i--) if (trades[i].items.length < 2) trades.splice(i, 1);
  const seen = new Set();
  const sig = (t) => t.items.map((x) => `${x.playerId}>${x.to}`).sort().join(",");
  const uniq = trades.filter((t) => { const k = sig(t); if (seen.has(t.id) || seen.has(k)) return false; seen.add(t.id); seen.add(k); return true; }).sort((a, b) => a.date - b.date);
  const complete = fetched >= periods.length;

  // Players' starting points for their new team after the trade (needs weekly lineups).
  let weeks = null;
  if (!past) {
    // This season: starting points so far, from finished weeks.
    const cur = await loadSeason();
    weeks = Object.fromEntries(cur.weeks.map((w) => [w.week, { rows: w.teams.map((t) => ({ teamId: t.teamId, starters: (t.starters || []).map((p) => ({ id: p.id, pts: p.pts })), roster: [...(t.starters || []), ...(t.bench || [])].map((p) => p.id) })) }]));
  }
  if (past && complete) {
    const sw = await seasonWeeks(Y, deadline + 2500);
    const po = sw.done ? await playoffWeeks(Y, deadline + 3500).catch(() => ({})) : null;
    if (sw.done && po) weeks = { ...sw.results, ...po };
  }
  // Third source: read trades straight off the weekly rosters. When players go directly from team A's roster to
  // team B's while B's players go to A in the same week, that's a trade. Draft picks stand in for "week 0".
  if (weeks) {
    try {
      const rosterAt = {};
      for (const [w, wk] of Object.entries(weeks)) for (const r of wk.rows || []) (rosterAt[Number(w)] ||= {})[r.teamId] = new Set(r.roster || (r.starters || []).map((p) => p.id));
      try {
        const D = await seasonLeague(Y, ["mDraftDetail"]);
        const pre = {};
        for (const pk of D.draftDetail?.picks || []) (pre[pk.teamId] ||= new Set()).add(pk.playerId);
        if (Object.keys(pre).length) rosterAt[0] = pre;
      } catch {}
      const wks = Object.keys(rosterAt).map(Number).sort((a, b) => a - b);
      const known = new Set(uniq.flatMap((t) => t.items.map((x) => `${x.playerId}`)));
      for (let i = 1; i < wks.length; i++) {
        const prev = rosterAt[wks[i - 1]], cur = rosterAt[wks[i]];
        const moves = {}; // "A>B" -> [playerId]
        for (const [B, set] of Object.entries(cur)) for (const id of set) {
          if (prev[B]?.has(id)) continue;
          const A = Object.keys(prev).find((t) => t !== B && prev[t].has(id));
          if (A && !pickups.has(`${id}>${B}`) && !pickups.has(`${id}>0`)) (moves[`${A}>${B}`] ||= []).push(id);
        }
        const done = new Set();
        for (const k of Object.keys(moves)) {
          const [A, B] = k.split(">"), back = `${B}>${A}`, pair = [A, B].sort().join("-");
          if (!moves[back] || done.has(pair)) continue;
          done.add(pair);
          const ids = [...moves[k], ...moves[back]];
          if (ids.some((id) => known.has(String(id)))) continue; // already found by another source
          ids.forEach((id) => known.add(String(id)));
          uniq.push({ id: `rost:${Y}:${wks[i]}:${pair}`, period: wks[i], date: 0, fromRosters: true,
            items: [...moves[k].map((id) => ({ playerId: id, from: Number(A), to: Number(B) })), ...moves[back].map((id) => ({ playerId: id, from: Number(B), to: Number(A) }))] });
        }
      }
      uniq.sort((a, b) => a.period - b.period || a.date - b.date);
    } catch {}
  }
  // Activity entries can lack the receiving team or the week: work them out from who rostered the player afterward.
  if (weeks) {
    const wkNums = Object.keys(weeks).map(Number).sort((a, b) => a - b);
    for (const t of uniq.filter((x) => x.fromActivity)) {
      const teams = [...new Set(t.items.flatMap((x) => [x.from, x.to]).filter((v) => v > 0))];
      let first = null;
      for (const it of t.items) {
        for (const w of wkNums) {
          const owner = (weeks[w].rows || []).find((r) => (r.roster || r.starters?.map((p) => p.id) || []).includes(it.playerId));
          if (owner && teams.includes(owner.teamId) && owner.teamId !== it.from) { if (!(it.to > 0)) it.to = owner.teamId; if (first == null || w < first) first = w; break; }
        }
        if (!(it.to > 0) && teams.length === 2) it.to = teams.find((x) => x !== it.from);
      }
      if (first != null) t.period = first;
    }
  }
  {
    const keep = [], seenMoves = [];
    for (const t of uniq) {
      const mv = new Set(t.items.map((x) => `${x.playerId}>${x.to}`));
      // same trade if most of its moves were already listed (within 2 weeks)
      const dup = seenMoves.find((o) => Math.abs(o.period - t.period) <= 2 && [...mv].filter((m) => o.mv.has(m)).length >= Math.min(mv.size, o.mv.size) * 0.5);
      if (dup) continue;
      seenMoves.push({ mv, period: t.period }); keep.push(t);
    }
    uniq.length = 0; uniq.push(...keep);
  }
  const names = await tradeNames(Y, [...new Set(uniq.flatMap((t) => t.items.map((x) => x.playerId)))]);
  const teamName = Object.fromEntries(summary.teams.map((t) => [t.teamId, t]));
  const out = uniq.map((t) => {
    const byTeam = {};
    // Team 0 / negative ids are free agency (players dropped to make room), not a trade partner.
    for (const it of t.items) if (it.to != null && it.to > 0) (byTeam[it.to] ||= []).push(it);
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
    // Winner = the side that got more starting points from what it received.
    let verdict = null;
    if (weeks && sides.length >= 2) {
      const ranked = [...sides].sort((x, y) => y.pts - x.pts);
      const gap = ranked[0].pts - ranked[1].pts;
      verdict = gap < 0.005 ? { result: "tie", gap: 0, final: past } : { result: "win", winner: ranked[0].teamId, loser: ranked[ranked.length - 1].teamId, gap: r2(gap), final: past };
    }
    return { id: t.id, year: Y, week: t.period, date: t.date, sides, verdict };
  }).filter((t) => t.sides.length === 2 && t.sides.every((sd) => sd.received.length >= 1)); // exactly two teams, each getting someone
  const result = { year: Y, complete: complete && (!past || !uniq.length || weeks != null), available: true, trades: out };
  if (past && result.complete) await store().setJSON(key, result).catch(() => {});
  return result;
}

// Trades from the message board activity feed (message type 244 = traded), all pages.
async function activityTrades(year) {
  const Y = Number(year);
  const base = Y >= 2018 ? `${BASE}/${Y}/segments/0/leagues/${LEAGUE_ID}/communication/?view=kona_league_communication` : null;
  if (!base) return [];
  const out = [], seen = new Set();
  out.pickups = [];
  for (let page = 0; page < 40; page++) {
    const filter = { topics: { filterType: { value: ["ACTIVITY_TRANSACTIONS"] }, limit: 100, offset: page * 100, limitPerMessageSet: { value: 25 },
      sortMessageDate: { sortPriority: 1, sortAsc: false }, sortFor: { sortPriority: 2, sortAsc: false } } };
    const data = JSON.parse(await espnFetch(base, { "X-Fantasy-Filter": JSON.stringify(filter) }));
    const topics = data.topics || [];
    for (const t of topics) {
      if (seen.has(t.id)) continue; seen.add(t.id);
      // A trade moves players team-to-team in both directions (adds/drops involve free agency instead).
      // 178 = free-agent add, 180 = waiver add: remember them so they're never counted as trades
      for (const m of t.messages || []) if ((m.messageTypeId === 178 || m.messageTypeId === 180) && m.targetId != null) out.pickups.push(`${m.targetId}>${Number(m.to) || Number(m.from) || 0}`);
      // 244 = traded. Only real trade entries count.
      const items = (t.messages || []).filter((m) => m.messageTypeId === 244 && m.targetId != null)
        .map((m) => ({ playerId: m.targetId, from: Number(m.from) || null, to: Number(m.to) || null }));
      if (items.length >= 2) out.push({ id: `act:${t.id}`, period: 0, date: t.date || 0, items, fromActivity: true });
    }
    if (topics.length < 100) break;
  }
  return out;
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

// Favorite players for one season: weeks each player spent on each team's roster, plus his starting points in
// that team's head-to-head wins (the tiebreaker). Top 8 per team, with names.
export async function seasonFavorites(year, deadline) {
  const Y = Number(year), past = Y < Number(SEASON);
  const key = `hist/fav/v1/${Y}`;
  if (past) { const hit = await store().get(key, { type: "json" }).catch(() => null); if (hit) return hit; }
  const summary = await seasonSummaryCached(Y);
  const resultOf = {};
  for (const t of summary.teams) for (const g of t.games || []) (resultOf[t.teamId] ||= {})[g.w] = g.r;
  const tally = {};
  const bump = (teamId, id, week, startPts) => {
    const T = (tally[teamId] ||= {}), x = (T[id] ||= { weeks: 0, winPts: 0 });
    x.weeks++;
    if (startPts != null && resultOf[teamId]?.[week] === "W") x.winPts = r2(x.winPts + startPts);
  };
  let names = {};
  if (past) {
    const sw = await seasonWeeks(Y, deadline);
    if (!sw.done) return { year: Y, complete: false, teams: {} };
    for (const [w, wk] of Object.entries(sw.results)) for (const row of wk.rows || []) {
      const st = Object.fromEntries((row.starters || []).map((p) => [p.id, p.pts]));
      for (const id of row.roster || Object.keys(st).map(Number)) bump(row.teamId, id, Number(w), st[id]);
    }
  } else {
    const cur = await loadSeason();
    for (const { week, teams } of cur.weeks) for (const t of teams) {
      for (const p of t.starters || []) { bump(t.teamId, p.id, week, p.pts); names[p.id] = { name: p.name, pos: p.pos }; }
      for (const p of t.bench || []) { bump(t.teamId, p.id, week, null); names[p.id] = { name: p.name, pos: p.pos }; }
    }
  }
  const teams = {};
  for (const [teamId, T] of Object.entries(tally)) teams[teamId] = Object.entries(T).map(([id, x]) => ({ id: Number(id), ...x })).sort((a, b) => b.weeks - a.weeks || b.winPts - a.winPts).slice(0, 8);
  const need = [...new Set(Object.values(teams).flat().map((x) => x.id))].filter((id) => !names[id]);
  if (need.length) Object.assign(names, await tradeNames(Y, need));
  for (const list of Object.values(teams)) for (const x of list) { x.name = names[x.id]?.name || `Player ${x.id}`; x.pos = names[x.id]?.pos || ""; }
  const out = { year: Y, complete: true, teams };
  if (past) await store().setJSON(key, out).catch(() => {});
  return out;
}

// ======================= All-time teams =======================
// For one season: every player's regular-season points on each team that rostered him (starter or bench), so the site
// can build each manager's all-time lineup (best players he ever had) and each season's all-star lineup (and who had them).
export async function seasonAllTime(year, deadline) {
  const Y = Number(year), past = Y < Number(SEASON);
  const key = `hist/alltime/v3/${Y}`;
  if (past) { const hit = await store().get(key, { type: "json" }).catch(() => null); if (hit) return hit; }
  const summary = await seasonSummaryCached(Y);
  const reg = summary.regularSeasonWeeks || 14;
  let slotCounts = summary.slotCounts;
  const weekly = {};                                                               // week -> [{ teamId, players }]
  if (past) {
    const sw = await seasonWeeks(Y, deadline);
    if (!sw.done) return { year: Y, complete: false };
    for (const [w, wk] of Object.entries(sw.results)) if (Number(w) <= reg) weekly[w] = (wk.rows || []).map((r) => ({ teamId: r.teamId, players: r.lineup || (r.starters || []).map((p) => ({ ...p, s: 1 })) }));
  } else {
    const cur = await loadSeason();
    slotCounts = cur.league?.settings?.rosterSettings?.lineupSlotCounts || slotCounts;
    for (const { week, teams } of cur.weeks) weekly[week] = teams.map((t) => ({ teamId: t.teamId, players: t.all || [...(t.starters || []), ...(t.bench || [])] }));
  }
  const agg = {}, posOf = {};
  for (const rows of Object.values(weekly)) for (const r of rows) for (const p of r.players || []) {
    if (p.id == null || !p.pos) continue; posOf[p.id] = p.pos;
    const a = ((agg[p.id] ||= {})[r.teamId] ||= [0, 0, 0, 0]);             // points, weeks rostered, starts, games played
    a[0] += p.pts || 0; a[1]++; if (p.s) a[2]++; if (p.pts) a[3]++;
  }
  // every player who was on a roster (small enough to keep them all)
  const keep = new Set(Object.keys(agg));
  const byPos = {};
  for (const [pid, teams] of Object.entries(agg)) (byPos[posOf[pid]] ||= []).push([pid, Object.values(teams).reduce((s, x) => s + x[0], 0)]);
  for (const list of Object.values(byPos)) list.sort((a, b) => b[1] - a[1]);
  // positional rank: season points while on any roster in the league, among every player at the position
  const posRank = {};
  for (const list of Object.values(byPos)) list.forEach(([pid], i) => (posRank[pid] = i + 1));
  const ids = [...keep].map(Number);
  // names only for players an all-star lineup could use (10+ starts or games) or a league top 30, looked up in parallel
  const named = ids.filter((id) => (posRank[id] || 99) <= 30 || Object.values(agg[id]).some((x) => x[2] >= 10) || Object.values(agg[id]).reduce((a, x) => a + x[3], 0) >= 10);
  const chunks = []; for (let i = 0; i < named.length; i += 50) chunks.push(named.slice(i, i + 50));
  const names = Object.assign({}, ...(await Promise.all(chunks.map((c) => tradeNames(Y, c).catch(() => ({}))))));
  const players = ids.map((id) => ({ id, name: names[id]?.name || `Player ${id}`, pos: posOf[id], rank: posRank[id],
    teams: Object.fromEntries(Object.entries(agg[id]).map(([t, [pts, wk, st, g]]) => [t, [r2(pts), wk, st, g]])) }));
  const out = { year: Y, complete: true, regularSeasonWeeks: reg, weeks: Object.keys(weekly).length, slotCounts, players };
  if (past) await store().setJSON(key, out).catch(() => {});
  return out;
}

// ======================= Injury luck =======================
// What injuries cost each team, in wins, from public NFL data (nflverse on GitHub): weekly snap counts, injury reports,
// NFL roster status (injured reserve, PUP, suspended...), every player's weekly stats, Vegas lines, and an ID map.
//
// Which weeks count (K and D/ST excluded):
//   Missed: a player on the team's bench or IR, or a regular starter / early pick it dropped who never played again that
//     season, whose NFL team played while he didn't, for an injury: on injured reserve, PUP or the non-football-injury
//     list, on the injury report that week or the week before, out after leaving the previous game early, or still out
//     from an earlier injury, or a suspension that started after he had played that season. Suspensions known before
//     the season (already in his draft price), players who left the team, cuts and healthy scratches don't count.
//   Started but didn't play: a starter who sat for an injury (same test).
//   Left early: a starter whose snap share was under 60% of his normal (any player who normally plays 20%+ of snaps),
//     who was on that week's or the next week's injury report, or missed the next game hurt.
// Expected points (what he'd have scored healthy):
//   Healthy average = every game he played at a normal snap share, starter or bench, blended with a prior worth 3 games
//     (last season's points per game, or for a rookie early pick, what the player at his draft rank scored).
//   x Vegas: his NFL team's implied points that week / its average in his healthy games (0.8 to 1.25).
//   x Fill-in signal (missed weeks only): how much his position group's production rose without him, against how much
//     it usually rises when a player at that position is out, given half weight at most and less with few weeks.
// Cost (the luck number): the best lineup the team could have set with its injured players at their expected points,
//   minus the best lineup it could actually set, plus expected minus scored for starters locked into the lineup (left
//   early, started but didn't play). A deep bench softens the hit, like it does for real.
// Value over replacement (shown next to it): expected minus a league-wide replacement-level player at his position,
//   for regular starters and early picks, the same baseline for every team.
// Wins lost = how many more all-play wins those points would have bought that week. Injury luck = the league average
// wins lost minus the team's, so a healthier-than-average team is positive.
const NFLV = "https://github.com/nflverse/nflverse-data/releases/download";
const FANTASY_POS = new Set(["QB", "RB", "WR", "TE"]);
const INJURED_CODES = new Set(["R01", "R48", "R04", "R05"]);                 // injured reserve, IR-return, PUP, non-football injury
const SUSPENDED = "R40";
const NOT_INJURY_CODES = new Set(["R06", "R03", "R02", "R27", "R23"]);        // left squad, didn't report, retired, other lists
const PRIOR_GAMES = 3;

function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  return { head, rows, col: (name) => head.indexOf(name) };
}
async function nflvText(path) {
  const r = await fetch(`${NFLV}/${path}`, { redirect: "follow" });
  if (!r.ok) throw new Error(`nflverse ${path}: ${r.status}`);
  return r.text();
}
// Cached loader: past seasons forever, the current one for `fresh` ms. Returns null if the deadline passed before a download.
async function cachedNflv(key, fresh, deadline, build) {
  const hit = await store().get(key, { type: "json" }).catch(() => null);
  if (hit && (!fresh || Date.now() - (hit.at || 0) < fresh)) return hit;
  if (Date.now() > deadline) return hit || null;
  let out;
  try { out = await build(); } catch { out = { missing: true }; }
  out.at = Date.now();
  await store().setJSON(key, out).catch(() => {});
  return out;
}
// ESPN player id -> [pfr id (snap counts), gsis id (everything else)]
async function nflIdMap() {
  const key = "nflverse/idmap/v1";
  const hit = await store().get(key, { type: "json" }).catch(() => null);
  if (hit && Date.now() - (hit.at || 0) < 14 * 864e5) return hit.map;
  const t = parseCsv(await nflvText("players/players.csv"));
  const e = t.col("espn_id"), p = t.col("pfr_id"), g = t.col("gsis_id");
  const map = {};
  for (const r of t.rows) if (r[e]) map[r[e]] = [r[p] || "", r[g] || ""];
  await store().setJSON(key, { at: Date.now(), map }).catch(() => {});
  return map;
}
// Snaps and injury reports: snaps[pfr][week] = offense share, team[pfr][week], played[team][week], inj[gsis][week] = status
async function nflSeason(year) {
  const Y = Number(year), past = Y < Number(SEASON);
  const key = `nflverse/season/v1/${Y}`;
  const hit = await store().get(key, { type: "json" }).catch(() => null);
  if (hit && (past || Date.now() - (hit.at || 0) < 6 * 3600e3)) return hit;
  const out = { at: Date.now(), snaps: {}, team: {}, played: {}, inj: {} };
  const s = parseCsv(await nflvText(`snap_counts/snap_counts_${Y}.csv`));
  const [gt, wk, id, tm, pct] = ["game_type", "week", "pfr_player_id", "team", "offense_pct"].map(s.col);
  for (const r of s.rows) {
    if (r[gt] && r[gt] !== "REG") continue;
    const w = Number(r[wk]); if (!w || !r[id]) continue;
    ((out.snaps[r[id]] ||= {})[w] = Number(r[pct]) || 0);
    ((out.team[r[id]] ||= {})[w] = r[tm]);
    (out.played[r[tm]] ||= {})[w] = 1;
  }
  try {
    const j = parseCsv(await nflvText(`injuries/injuries_${Y}.csv`));
    const [jt, jw, jg, js] = ["game_type", "week", "gsis_id", "report_status"].map(j.col);
    for (const r of j.rows) {
      if (r[jt] && r[jt] !== "REG") continue;
      const w = Number(r[jw]); if (!w || !r[jg] || !r[js]) continue;
      (out.inj[r[jg]] ||= {})[w] = r[js];
    }
  } catch {}
  await store().setJSON(key, out).catch(() => {});
  return out;
}
// Weekly stats for every QB/RB/WR/TE: p[gsis] = { pos, w: { week: [team, standard points, catches] } }
function nflStats(year, deadline) {
  const Y = Number(year);
  return cachedNflv(`nflverse/stats/v1/${Y}`, Y < Number(SEASON) ? 0 : 6 * 3600e3, deadline, async () => {
    const t = parseCsv(await nflvText(`stats_player/stats_player_week_${Y}.csv`));
    const [id, pos, wk, st, fp, rec] = ["player_id", "position", "week", "season_type", "fantasy_points", "receptions"].map(t.col);
    const tm = t.col("team") >= 0 ? t.col("team") : t.col("recent_team");
    const p = {};
    for (const r of t.rows) {
      if (r[st] && r[st] !== "REG") continue;
      const ps = r[pos] === "FB" ? "RB" : r[pos];
      if (!FANTASY_POS.has(ps)) continue;
      const w = Number(r[wk]); if (!w || !r[id]) continue;
      (p[r[id]] ||= { pos: ps, w: {} }).w[w] = [r[tm], Math.round((Number(r[fp]) || 0) * 100) / 100, Number(r[rec]) || 0];
    }
    return { p };
  });
}
// NFL roster status by week, only when it isn't plain "active": s[gsis][week] = code (R01 injured reserve, R40 suspended, INA...)
function nflRosterStatus(year, deadline) {
  const Y = Number(year);
  return cachedNflv(`nflverse/rost/v1/${Y}`, Y < Number(SEASON) ? 0 : 6 * 3600e3, deadline, async () => {
    const t = parseCsv(await nflvText(`weekly_rosters/roster_weekly_${Y}.csv`));
    const [pos, st, g, wk, gt, ab] = ["position", "status", "gsis_id", "week", "game_type", "status_description_abbr"].map(t.col);
    const s = {};
    for (const r of t.rows) {
      if (r[gt] && r[gt] !== "REG") continue;
      if (!FANTASY_POS.has(r[pos] === "FB" ? "RB" : r[pos])) continue;
      const w = Number(r[wk]); if (!w || !r[g]) continue;
      const code = r[st] === "CUT" ? "CUT" : r[ab] && r[ab] !== "A01" ? r[ab] : r[st] === "INA" ? "INA" : "";
      if (code) (s[r[g]] ||= {})[w] = code;
    }
    return { s };
  });
}
// Vegas: each team's implied points per game, l[season][week][team] (from the closing spread and total)
function nflLines(deadline) {
  return cachedNflv("nflverse/lines/v1", 12 * 3600e3, deadline, async () => {
    const t = parseCsv(await nflvText("schedules/games.csv"));
    const [se, gt, wk, at, ht, sp, tot] = ["season", "game_type", "week", "away_team", "home_team", "spread_line", "total_line"].map(t.col);
    const l = {};
    for (const r of t.rows) {
      const y = Number(r[se]); if (y < 2012 || (r[gt] && r[gt] !== "REG")) continue;
      const total = Number(r[tot]), spread = Number(r[sp]); if (!r[tot] || !Number.isFinite(total) || !Number.isFinite(spread)) continue;
      const w = Number(r[wk]), x = ((l[y] ||= {})[w] ||= {});
      x[r[ht]] = Math.round(((total + spread) / 2) * 10) / 10;
      x[r[at]] = Math.round(((total - spread) / 2) * 10) / 10;
    }
    return { l };
  });
}

export async function seasonInjury(year, deadline) {
  const Y = Number(year), past = Y < Number(SEASON);
  const key = `hist/injury/v3/${Y}`;
  const incomplete = { year: Y, complete: false, teams: {} };
  if (past) { const hit = await store().get(key, { type: "json" }).catch(() => null); if (hit) return hit; }
  const summary = await seasonSummaryCached(Y);
  const reg = summary.regularSeasonWeeks || 14;
  let slotCounts = summary.slotCounts;
  // Weekly rosters: { week: [{ teamId, players: [{ id, pos, pts, s (1 = starter) }], elig: { pos: lineup slots } }] }
  const lineups = {};
  if (past) {
    const sw = await seasonWeeks(Y, deadline);
    if (!sw.done) return incomplete;
    for (const [w, wk] of Object.entries(sw.results)) if (Number(w) <= reg) lineups[w] = (wk.rows || []).map((r) => ({ teamId: r.teamId, players: r.lineup || null, elig: wk.elig || {} }));
  } else {
    const cur = await loadSeason();
    slotCounts = cur.league?.settings?.rosterSettings?.lineupSlotCounts || slotCounts;
    for (const { week, teams } of cur.weeks) lineups[week] = teams.map((t) => ({ teamId: t.teamId, players: t.all || null, elig: t.elig || {} }));
  }
  const weeks = Object.keys(lineups).map(Number).sort((a, b) => a - b);
  if (!weeks.length || !slotCounts) return { year: Y, complete: true, available: false, teams: {} };
  if (Date.now() > deadline) return incomplete;

  // NFL data, each piece cached on its own, so a cold start finishes over a few calls
  let ids, nfl;
  try { ids = await nflIdMap(); if (Date.now() > deadline) return incomplete; nfl = await nflSeason(Y); }
  catch { return { year: Y, complete: true, available: false, teams: {}, note: "NFL injury data unavailable" }; }
  const stats = await nflStats(Y, deadline); if (!stats) return incomplete;
  const prev = await nflStats(Y - 1, deadline); if (!prev) return incomplete;
  const rost = await nflRosterStatus(Y, deadline); if (!rost) return incomplete;
  const lines = await nflLines(deadline); if (!lines) return incomplete;

  // Team scores per week (regular season), for the all-play math
  const scores = {};
  for (const t of summary.teams) for (const g of t.games || []) if (g.w <= reg) (scores[g.w] ||= {})[t.teamId] = g.pts;
  const pfr = (pid) => ids[String(pid)]?.[0], gsis = (pid) => ids[String(pid)]?.[1];
  const snap = (pid, w) => { const k = pfr(pid); return k ? nfl.snaps[k]?.[w] : undefined; };
  const nflTeam = (pid, w) => {
    const t = nfl.team[pfr(pid)] || {}; if (t[w]) return t[w];
    const ks = Object.keys(t).map(Number); if (!ks.length) return null;
    const near = ks.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a)); return t[near];
  };
  const teamPlayed = (pid, w) => { const tm = nflTeam(pid, w); return tm ? Boolean(nfl.played[tm]?.[w]) : false; };
  const onReport = (pid, w) => Boolean(nfl.inj[gsis(pid)]?.[w]);
  const rcode = (pid, w) => rost.s?.[gsis(pid)]?.[w] || "";
  const playedAt = (pid, w) => (snap(pid, w) || 0) > 0;
  const lastWeekPlayed = (pid) => Math.max(0, ...Object.entries(nfl.snaps[pfr(pid)] || {}).filter(([, v]) => v > 0).map(([w]) => Number(w)));
  const maxW = Math.max(0, ...Object.values(nfl.played).flatMap((x) => Object.keys(x).map(Number)));
  const nflWeeks = Array.from({ length: maxW }, (_, i) => i + 1);
  const memo = (fn) => { const m = new Map(); return (...a) => { const k = a.join("|"); if (!m.has(k)) m.set(k, fn(...a)); return m.get(k); }; };
  const medianShare = memo((pid) => { const v = Object.values(nfl.snaps[pfr(pid)] || {}).filter((x) => x > 0).sort((a, b) => a - b); return v.length >= 3 ? v[Math.floor(v.length / 2)] : null; });
  const lowSnaps = (pid, w) => { const s = snap(pid, w), m = medianShare(pid); return s > 0 && m != null && m >= 0.2 && s < 0.6 * m; };
  const healthyAt = (pid, w) => { const s = snap(pid, w); if (!(s > 0)) return false; const m = medianShare(pid); return m == null || s >= 0.6 * m; };
  // A suspension counts when it starts after he has played that season (a surprise); one known before the season doesn't
  const suspendedMidSeason = memo((pid) => {
    const sw = nflWeeks.filter((w) => rcode(pid, w) === SUSPENDED); if (!sw.length) return false;
    return nflWeeks.some((w) => w < sw[0] && playedAt(pid, w));
  });
  // Didn't play because of an injury or a mid-season suspension (not a cut, a healthy scratch or a known suspension)
  const injuredOut = memo((pid, w) => {
    const c = rcode(pid, w);
    if (INJURED_CODES.has(c)) return true;
    if (c === SUSPENDED) return suspendedMidSeason(pid);
    if (NOT_INJURY_CODES.has(c) || c === "CUT") return false;
    if (onReport(pid, w) || onReport(pid, w - 1)) return true;
    if (w > 1 && lowSnaps(pid, w - 1)) return true;                                     // left last week's game early
    if (w > 1 && !playedAt(pid, w - 1) && teamPlayed(pid, w - 1)) return injuredOut(pid, w - 1); // still out from earlier
    return false;
  });
  const leftEarly = (pid, w) => lowSnaps(pid, w) && (onReport(pid, w) || onReport(pid, w + 1) || (teamPlayed(pid, w + 1) && !playedAt(pid, w + 1) && injuredOut(pid, w + 1)));
  const outHurt = (pid, w) => teamPlayed(pid, w) && !playedAt(pid, w) && injuredOut(pid, w);

  // League scoring: ESPN's points when the player was on anyone's roster, otherwise nflverse stats scaled to match
  const posOf = {}, espnPts = {};
  for (const w of weeks) for (const r of lineups[w]) for (const p of r.players || []) { if (p.pos) posOf[p.id] = p.pos; (espnPts[p.id] ||= {})[w] = p.pts; }
  const nflvRaw = (g, w, src = stats) => { const e = src.p?.[g]?.w?.[w]; return e ? e[1] + REC_WEIGHT * e[2] : null; };
  const calib = {};
  { const sum = {};
    for (const [pid, wk] of Object.entries(espnPts)) { const g = gsis(pid), pos = posOf[pid]; if (!g || !FANTASY_POS.has(pos)) continue;
      for (const [w, v] of Object.entries(wk)) { const n = nflvRaw(g, w); if (n == null || n <= 0 || !playedAt(pid, w)) continue; const s = (sum[pos] ||= [0, 0]); s[0] += v; s[1] += n; } }
    for (const [pos, [e, n]] of Object.entries(sum)) calib[pos] = n > 50 ? e / n : 1; }
  const cal = (pos) => calib[pos] || 1;
  const ptsAt = (pid, w) => espnPts[pid]?.[w] ?? (() => { const n = nflvRaw(gsis(pid), w); return n == null ? null : n * cal(posOf[pid]); })();

  // Replacement level by position: points per start of every player with 3+ starts this season, ranked; replacement =
  // the first player past the league's starting spots (counted from how many each team actually started there).
  const starts = {}, slotsUsed = {};
  let teamWeeks = 0;
  for (const w of weeks) for (const r of lineups[w]) {
    if (!r.players) continue; teamWeeks++;
    for (const p of r.players) { if (!p.s || !p.pos) continue; (starts[p.id] ||= []).push(p.pts); slotsUsed[p.pos] = (slotsUsed[p.pos] || 0) + 1; }
  }
  const nTeams = Math.max(1, new Set(weeks.flatMap((w) => lineups[w].map((r) => r.teamId))).size);
  const minStarts = weeks.length >= 6 ? 3 : 1;
  const ppgList = {};
  for (const [pid, arr] of Object.entries(starts)) { if (arr.length < minStarts) continue; (ppgList[posOf[pid]] ||= []).push(arr.reduce((a, b) => a + b, 0) / arr.length); }
  for (const k of Object.keys(ppgList)) ppgList[k].sort((a, b) => b - a);
  const replacement = {};
  for (const [pos, used] of Object.entries(slotsUsed)) {
    const spots = Math.round((used / Math.max(1, teamWeeks)) * nTeams), list = ppgList[pos] || [];
    replacement[pos] = list.length ? r2(list[Math.min(spots, list.length - 1)]) : 0;
  }
  const repl = (pos) => replacement[pos] ?? 0;

  // Early draft picks (rounds 1-6): position, and what the player at their draft rank at that position scored
  const early = {};
  try {
    const D = await seasonLeague(Y, ["mDraftDetail"]);
    const picks = (D.draftDetail?.picks || []).filter((pk) => pk.roundId && pk.roundId <= 6 && pk.playerId > 0).sort((a, b) => (a.overallPickNumber || 0) - (b.overallPickNumber || 0));
    const needPos = picks.map((pk) => pk.playerId).filter((id) => !posOf[id]);
    const names = needPos.length ? await tradeNames(Y, needPos).catch(() => ({})) : {};
    const rankAt = {};
    for (const pk of picks) {
      const pos = posOf[pk.playerId] || names[pk.playerId]?.pos; if (!pos || pos === "K" || pos === "D/ST") continue;
      posOf[pk.playerId] ||= pos;
      const k = (rankAt[pos] = (rankAt[pos] || 0) + 1), list = ppgList[pos] || [];
      early[pk.playerId] = { teamId: pk.teamId, pos, expected: list.length ? list[Math.min(k - 1, list.length - 1)] : null };
    }
  } catch {}

  // Healthy average, blended with a prior worth PRIOR_GAMES games
  const healthyWeeks = memo((pid) => nflWeeks.filter((w) => healthyAt(pid, w) && ptsAt(pid, w) != null));
  const priorPpg = memo((pid) => {
    const e = prev.p?.[gsis(pid)]; if (!e) return null;
    const v = Object.keys(e.w).map((w) => nflvRaw(gsis(pid), w, prev)).filter((x) => x != null);
    return v.length >= 4 ? (v.reduce((a, b) => a + b, 0) / v.length) * cal(posOf[pid]) : null;
  });
  const base = memo((pid) => {
    const hw = healthyWeeks(pid), sum = hw.reduce((a, w) => a + ptsAt(pid, w), 0);
    const prior = priorPpg(pid) ?? early[pid]?.expected ?? null;
    if (!hw.length && prior == null) return null;
    return prior == null ? sum / hw.length : (sum + PRIOR_GAMES * prior) / (hw.length + PRIOR_GAMES);
  });
  // Vegas: his team's implied points that week against its average in his healthy games
  const implied = (team, w) => lines.l?.[Y]?.[w]?.[team];
  const vegas = memo((pid, w) => {
    const now = implied(nflTeam(pid, w), w); if (!now) return 1;
    let ref = healthyWeeks(pid).map((x) => implied(nflTeam(pid, x), x)).filter(Boolean);
    if (!ref.length) ref = Object.values(lines.l?.[Y] || {}).map((x) => x[nflTeam(pid, w)]).filter(Boolean);
    if (!ref.length) return 1;
    return Math.min(1.25, Math.max(0.8, now / (ref.reduce((a, b) => a + b, 0) / ref.length)));
  });
  // Fill-in signal: his position group's points without him, per week
  const groupIdx = {};
  for (const [g, e] of Object.entries(stats.p || {})) for (const [w, x] of Object.entries(e.w)) (groupIdx[`${x[0]}|${e.pos}|${w}`] ||= []).push([g, x[1] + REC_WEIGHT * x[2]]);
  const groupPts = (team, pos, w, except) => (groupIdx[`${team}|${pos}|${w}`] || []).reduce((a, [g, v]) => a + (g === except ? 0 : v), 0) * cal(pos);
  const absenceRatios = memo((pid) => {
    const b = base(pid), pos = posOf[pid], g = gsis(pid);
    if (!b || !g || !FANTASY_POS.has(pos)) return [];
    const hw = healthyWeeks(pid); if (!hw.length) return [];
    const usual = hw.reduce((a, w) => a + groupPts(nflTeam(pid, w), pos, w, g), 0) / hw.length;
    return nflWeeks.filter((w) => outHurt(pid, w))
      .map((w) => ((groupPts(nflTeam(pid, w), pos, w, g) - usual) / vegas(pid, w)) / b);
  });
  // How much a position group usually picks up when a player there is out (league-wide, this season)
  const rho = {};
  { const all = {};
    for (const pid of Object.keys(espnPts)) { const pos = posOf[pid]; if (!FANTASY_POS.has(pos)) continue; const r = absenceRatios(pid); if (r.length) (all[pos] ||= []).push(r.reduce((a, b) => a + b, 0) / r.length); }
    for (const pos of FANTASY_POS) { const v = (all[pos] || []).sort((a, b) => a - b); rho[pos] = v.length >= 5 ? Math.max(0.2, v[Math.floor(v.length / 2)]) : 0.6; } }
  const fillIn = memo((pid) => {
    const r = absenceRatios(pid), pos = posOf[pid]; if (!r.length || !rho[pos]) return 1;
    const m = r.length, avg = r.reduce((a, b) => a + b, 0) / m, wgt = 0.5 * (m / (m + 2));
    return Math.min(1.3, Math.max(0.8, 1 + wgt * (avg / rho[pos] - 1)));
  });
  const expected = (pid, w, missed) => { const b = base(pid); return b == null ? null : b * vegas(pid, w) * (missed ? fillIn(pid) : 1); };

  const result = {};
  const teamIds = [...new Set(weeks.flatMap((w) => lineups[w].map((r) => r.teamId)))];
  for (const tid of teamIds) {
    const rowAt = (w) => lineups[w]?.find((r) => r.teamId === tid);
    const startedFor = {};                                                                   // pid -> weeks started for this team
    for (const w of weeks) for (const p of rowAt(w)?.players || []) if (p.s) (startedFor[p.id] ||= new Set()).add(w);
    // a regular starter: started 2 of his last 3 available weeks for this team, or all of them if fewer than 3
    const regular = (pid, w) => {
      const prior = weeks.filter((x) => x < w && (playedAt(pid, x) || startedFor[pid]?.has(x))).slice(-3);
      const n = prior.filter((x) => startedFor[pid]?.has(x)).length;
      return prior.length > 0 && n >= Math.min(2, prior.length);
    };
    const earlyPick = (pid, w) => early[pid]?.teamId === tid && !weeks.some((x) => x < w && (startedFor[pid]?.has(x) || playedAt(pid, x)));
    const events = [], lostByWeek = {}, vorByWeek = {};
    for (const w of weeks) {
      const row = rowAt(w); if (!row?.players) continue;
      const P = row.players.filter((p) => p.id != null);
      const onAny = new Set(lineups[w].flatMap((r) => (r.players || []).map((p) => p.id)));
      const locked = [], missed = [];
      for (const p of P) {
        if (!FANTASY_POS.has(p.pos) || !pfr(p.id)) continue;
        if (p.s) {
          if (outHurt(p.id, w)) { const e = expected(p.id, w, true); if (e != null) locked.push({ pid: p.id, pos: p.pos, kind: "started but didn't play", exp: e, got: p.pts }); }
          else if (leftEarly(p.id, w)) { const e = expected(p.id, w, false); if (e != null) locked.push({ pid: p.id, pos: p.pos, kind: "left early", exp: e, got: p.pts }); }
        } else if (outHurt(p.id, w)) {
          const e = expected(p.id, w, true); if (e != null) missed.push({ pid: p.id, pos: p.pos, exp: e, onRoster: true, vor: regular(p.id, w) || earlyPick(p.id, w) });
        }
      }
      // dropped regular starters and early picks, hurt, who never played again that season
      const cands = new Set([...Object.keys(startedFor).map(Number), ...Object.keys(early).map(Number).filter((id) => early[id].teamId === tid)]);
      for (const pid of cands) {
        if (onAny.has(pid) || !FANTASY_POS.has(posOf[pid]) || !pfr(pid)) continue;
        if (!(regular(pid, w) || earlyPick(pid, w)) || !outHurt(pid, w) || lastWeekPlayed(pid) > w) continue;
        if (!weeks.some((x) => x < w && (rowAt(x)?.players || []).some((p) => p.id === pid)) && !earlyPick(pid, w)) continue;
        const e = expected(pid, w, true); if (e != null) missed.push({ pid, pos: posOf[pid], exp: e, onRoster: false, vor: true });
      }
      if (!locked.length && !missed.length) continue;
      // Realized cost: best lineup with the injured players at their expected points, minus the best lineup actually available
      const elig = (pos) => row.elig?.[pos] || [];
      const lineupWith = (restore) => [
        ...P.map((p) => ({ id: p.id, eligible: elig(p.pos), actual: restore.has(p.id) ? restore.get(p.id) : p.pts })),
        ...missed.filter((m) => !m.onRoster && restore.has(m.pid)).map((m) => ({ id: m.pid, eligible: elig(m.pos), actual: restore.get(m.pid) })),
      ];
      const best0 = optimalPoints(lineupWith(new Map()), slotCounts);
      const all = new Map(missed.map((m) => [m.pid, m.exp]));
      const missedCost = Math.max(0, optimalPoints(lineupWith(all), slotCounts) - best0);
      const lockedCost = locked.reduce((a, x) => a + Math.max(0, x.exp - x.got), 0);
      const vorCost = lockedCost + missed.filter((m) => m.vor).reduce((a, m) => a + Math.max(0, m.exp - repl(m.pos)), 0);
      lostByWeek[w] = missedCost + lockedCost; vorByWeek[w] = vorCost;
      for (const x of locked) events.push({ week: w, playerId: x.pid, kind: x.kind, expected: r2(x.exp), scored: r2(x.got), lost: r2(Math.max(0, x.exp - x.got)) });
      for (const m of missed) {
        const one = Math.max(0, optimalPoints(lineupWith(new Map([[m.pid, m.exp]])), slotCounts) - best0);
        events.push({ week: w, playerId: m.pid, kind: "missed", expected: r2(m.exp), lost: r2(one), overReplacement: m.vor ? r2(Math.max(0, m.exp - repl(m.pos))) : null });
      }
    }
    // wins lost through the all-play: same opponents' scores, this team's score plus what injuries cost it
    const toWins = (byWeek) => {
      let wins = 0, pts = 0;
      for (const [w, lost] of Object.entries(byWeek)) {
        const sc = scores[w]; if (!sc || sc[tid] == null) continue;
        const others = Object.entries(sc).filter(([t]) => Number(t) !== tid).map(([, v]) => v);
        if (!others.length) continue;
        const exp = (x) => others.reduce((a, o) => a + (x > o ? 1 : x === o ? 0.5 : 0), 0) / others.length;
        wins += exp(sc[tid] + lost) - exp(sc[tid]); pts += lost;
      }
      return [r2(pts), r2(wins)];
    };
    const [pointsLost, winsLost] = toWins(lostByWeek), [vorPoints, vorWins] = toWins(vorByWeek);
    result[tid] = { pointsLost, winsLost, vorPoints, vorWins, events: events.filter((e) => e.lost > 0.5 || (e.overReplacement || 0) > 0.5).sort((a, b) => b.lost - a.lost).slice(0, 8) };
  }
  const tids = Object.keys(result), n = Math.max(1, tids.length);
  const avg = tids.reduce((a, t) => a + result[t].winsLost, 0) / n, avgV = tids.reduce((a, t) => a + result[t].vorWins, 0) / n;
  for (const t of tids) { result[t].luck = r2(avg - result[t].winsLost); result[t].vorLuck = r2(avgV - result[t].vorWins); }
  const need = [...new Set(Object.values(result).flatMap((x) => x.events.map((e) => e.playerId)))];
  const names = await tradeNames(Y, need).catch(() => ({}));
  for (const x of Object.values(result)) for (const e of x.events) e.name = names[e.playerId]?.name || `Player ${e.playerId}`;
  const out = {
    year: Y, complete: true, available: true, avgWinsLost: r2(avg), replacement,
    model: { priorGames: PRIOR_GAMES, scoringScale: Object.fromEntries(Object.entries(calib).map(([k, v]) => [k, r2(v)])), fillInBaseline: Object.fromEntries(Object.entries(rho).map(([k, v]) => [k, r2(v)])) },
    teams: result,
  };
  if (past) await store().setJSON(key, out).catch(() => {});
  return out;
}
