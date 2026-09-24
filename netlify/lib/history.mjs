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
      h2h: rec(), median: rec(), regPF: 0, regGames: 0,
    };
  }
  const byWeek = {};
  for (const g of L.schedule || []) if (g.matchupPeriodId <= reg) (byWeek[g.matchupPeriodId] ||= []).push(g);
  let weeksDone = 0;
  for (const games of Object.values(byWeek)) {
    if (!games.every(decided)) continue;
    weeksDone++;
    const scores = [];
    for (const g of games) {
      if (!g.away) continue;
      const h = teams[g.home.teamId], a = teams[g.away.teamId]; if (!h || !a) continue;
      const hp = g.home.totalPoints || 0, ap = g.away.totalPoints || 0;
      h.regPF += hp; a.regPF += ap; h.regGames++; a.regGames++;
      scores.push([h, hp], [a, ap]);
      if (g.winner === "HOME") { h.h2h.w++; a.h2h.l++; } else if (g.winner === "AWAY") { a.h2h.w++; h.h2h.l++; } else { h.h2h.t++; a.h2h.t++; }
    }
    const med = median(scores.map((x) => x[1]));
    scores.forEach(([t, p]) => (p > med ? t.median.w++ : p < med ? t.median.l++ : t.median.t++));
  }
  const list = Object.values(teams);
  list.forEach((t) => (t.regPF = r2(t.regPF)));
  const games = (r) => r.w + r.l + r.t;
  const usesMedian = list.some((t) => games(t.official) > games(t.h2h));
  const complete = Number(year) < Number(SEASON) && weeksDone >= Object.keys(byWeek).length;
  return {
    year: Number(year), complete, usesMedian, regularSeasonWeeks: reg,
    slotCounts: L.settings?.rosterSettings?.lineupSlotCounts || null,
    previousSeasons: L.status?.previousSeasons || null,
    members, teams: list,
  };
}

export async function seasonSummaryCached(year) {
  const key = `hist/season/v1/${year}`;
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

// "If man" results for one season: best lineups, head-to-head and median.
// Past weeks are cached one at a time so a slow first run picks up where it left off.
export async function seasonIfMan(year, deadline) {
  if (Number(year) === Number(SEASON)) {
    const s = await loadSeason();
    return { year: Number(year), complete: true, available: true, teams: tally(s.weeks.map((w) => w.teams.map((t) => ({ teamId: t.teamId, oppId: t.oppId, optimal: t.optimal })))) };
  }
  const summary = await seasonSummaryCached(year);
  if (!summary.slotCounts) return { year: Number(year), complete: true, available: false, teams: {} };
  const weeks = Array.from({ length: summary.regularSeasonWeeks }, (_, i) => i + 1);
  const results = {};
  let pending = [...weeks];
  while (pending.length) {
    if (Date.now() > deadline) break;
    const batch = pending.splice(0, 5);
    await Promise.all(batch.map(async (w) => {
      const key = `hist/ifman/v1/${year}/w${w}`;
      let rows = await store().get(key, { type: "json" }).catch(() => null);
      if (!rows) {
        const L = await seasonLeague(year, ["mMatchupScore", "mScoreboard"], w);
        rows = [];
        for (const g of (L.schedule || []).filter((x) => x.matchupPeriodId === w)) {
          for (const [s, o] of [[g.home, g.away], [g.away, g.home]]) {
            if (!s) continue;
            const players = rosterOf(s).map((e) => parsePlayer(e, w));
            rows.push({ teamId: s.teamId, oppId: o ? o.teamId : null, optimal: players.length ? Math.max(r2(s.totalPoints), optimalPoints(players, summary.slotCounts)) : null });
          }
        }
        await store().setJSON(key, rows).catch(() => {});
      }
      results[w] = rows;
    }));
  }
  const done = Object.keys(results).length === weeks.length;
  const all = weeks.map((w) => results[w]).filter(Boolean);
  const available = all.length > 0 && all.every((rows) => rows.length && rows.every((r) => r.optimal != null));
  return { year: Number(year), complete: done, available: done ? available : null, teams: done && available ? tally(all) : {} };
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
