// League story, served at /api/story?week=N.
// Team of the Week: best possible lineup from every player's actual points that week,
// rostered or not, with who owned each player that week. Plus trends for every team.
import { getStore } from "@netlify/blobs";
import { BASE, SEASON, LEAGUE_ID, EspnError, espnFetch, leagueUrl } from "../lib/espn.mjs";
import { median, optimalLineup, parsePlayer, rosterOf, POS, isStarter } from "../lib/model.mjs";
import { loadSeason } from "../lib/season.mjs";

const json = (status, obj, cache = "no-store") => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": cache },
});
const r2 = (n) => Math.round((n || 0) * 100) / 100;
const POSITION_SLOTS = [0, 2, 4, 6, 16, 17]; // QB, RB, WR, TE, D/ST, K

async function topPlayers(week) {
  const url = `${BASE}/${SEASON}/segments/0/leagues/${LEAGUE_ID}?view=kona_player_info&scoringPeriodId=${week}`;
  const lists = await Promise.all(POSITION_SLOTS.map(async (slot) => {
    const filter = { players: {
      filterSlotIds: { value: [slot] }, limit: 15,
      sortAppliedStatTotalForScoringPeriodId: { sortAsc: false, sortPriority: 1, value: week },
    } };
    const data = JSON.parse(await espnFetch(url, { "X-Fantasy-Filter": JSON.stringify(filter) }));
    return (data.players || []).map((p) => parsePlayer({ playerId: p.id, lineupSlotId: 20, playerPoolEntry: { player: p.player || p } }, week));
  }));
  return lists.flat();
}

async function teamOfWeek(week, slotCounts) {
  const league = JSON.parse(await espnFetch(leagueUrl(["mMatchupScore", "mScoreboard"], week)));
  const owner = {}, pool = {};
  let topTeam = 0;
  for (const g of (league.schedule || []).filter((x) => x.matchupPeriodId === week)) {
    for (const s of [g.home, g.away]) {
      if (!s) continue;
      topTeam = Math.max(topTeam, s.totalPoints || 0);
      for (const e of rosterOf(s)) {
        const p = parsePlayer(e, week);
        owner[p.id] = { teamId: s.teamId, started: isStarter(p) };
        pool[p.id] = p;
      }
    }
  }
  let freeAgents = true;
  try { for (const p of await topPlayers(week)) if (!pool[p.id]) pool[p.id] = p; }
  catch { freeAgents = false; }
  const lineup = optimalLineup(Object.values(pool), slotCounts).map(({ slotId, player: p }) => ({
    slotId, name: p.name, pos: p.pos, points: r2(p.actual),
    ownerTeamId: owner[p.id]?.teamId ?? null, started: owner[p.id]?.started ?? false,
  }));
  return { week, lineup, total: r2(lineup.reduce((a, x) => a + x.points, 0)), topTeamScore: r2(topTeam), freeAgentsIncluded: freeAgents };
}

function trends(weeks) {
  const perTeam = {};
  for (const { week, teams } of weeks) {
    const med = median(teams.map((t) => t.actual));
    for (const t of teams) (perTeam[t.teamId] ||= []).push({ week, score: t.actual, vsMed: t.actual - med, result: t.result });
  }
  return Object.entries(perTeam).map(([id, rows]) => {
    rows.sort((a, b) => a.week - b.week);
    const res = rows.map((r) => r.result).filter((r) => r !== "BYE");
    let len = 0; const type = res[res.length - 1] || null;
    for (let i = res.length - 1; i >= 0 && res[i] === type; i--) len++;
    const k = Math.min(3, rows.length);
    const recent = rows.slice(-k);
    const form = recent.reduce((a, r) => a + r.vsMed, 0) / k;
    const n = rows.length;
    const mean = rows.reduce((a, r) => a + r.vsMed, 0) / n;
    const sd = n >= 2 ? Math.sqrt(rows.reduce((a, r) => a + (r.vsMed - mean) ** 2, 0) / (n - 1)) : null;
    const signed = type === "W" ? len : type === "L" ? -len : 0;
    return {
      teamId: Number(id), weeks: n, streak: { type, len }, recentWeeks: k, recentVsMedian: r2(form),
      avg: r2(rows.reduce((a, r) => a + r.score, 0) / n), swing: sd == null ? null : r2(sd),
      trend: r2(signed + form / 15), scores: rows.map((r) => r2(r.score)),
    };
  });
}

export default async (req) => {
  const url = new URL(req.url);
  let season;
  try { season = await loadSeason(); }
  catch (e) { return json(e instanceof EspnError ? e.status : 500, { error: e.message || "Couldn't load the league story." }); }
  const done = season.weeks.map((w) => w.week);
  if (!done.length) return json(200, { weeks: [], teamOfWeek: null, trends: [] }, "public, max-age=120");
  let week = Number(url.searchParams.get("week"));
  if (!done.includes(week)) week = done[done.length - 1];

  const slotCounts = season.league.settings?.rosterSettings?.lineupSlotCounts;
  const key = `tow/v1/w${week}`;
  const s = getStore({ name: "cache", consistency: "strong" });
  let tow = await s.get(key, { type: "json" }).catch(() => null);
  if (!tow) {
    try {
      tow = await teamOfWeek(week, slotCounts);
      if (tow.freeAgentsIncluded) await s.setJSON(key, tow).catch(() => {});
    } catch (e) { tow = { week, error: e.message || "Couldn't build Team of the Week." }; }
  }
  return json(200, { weeks: done, teamOfWeek: tow, trends: trends(season.weeks) }, "public, max-age=120");
};

export const config = { path: "/api/story" };
