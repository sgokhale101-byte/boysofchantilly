// "If man" standings: every team starts its best possible lineup each completed week.
// Served at /api/ifman. Finished weeks are cached in Netlify Blobs since they never change.
import { getStore } from "@netlify/blobs";
import { EspnError, espnFetch, leagueUrl } from "../lib/espn.mjs";
import { optimalPoints, parsePlayer, rosterOf } from "../lib/model.mjs";

const json = (status, obj, cache = "no-store") => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": cache, ...(status === 200 ? { "netlify-cdn-cache-control": "public, s-maxage=300" } : {}) },
});

async function computeWeek(week, slotCounts) {
  const league = JSON.parse(await espnFetch(leagueUrl(["mMatchupScore", "mScoreboard"], week)));
  const games = (league.schedule || []).filter((g) => g.matchupPeriodId === week);
  return games.map((g) => {
    const side = (s) => s && ({
      teamId: s.teamId,
      actual: s.totalPoints ?? 0,
      optimal: optimalPoints(rosterOf(s).map((e) => parsePlayer(e, week)), slotCounts),
    });
    return { home: side(g.home), away: side(g.away) };
  });
}

export default async () => {
  let league;
  try {
    league = JSON.parse(await espnFetch(leagueUrl(["mMatchupScore", "mSettings", "mStatus"])));
  } catch (e) {
    return json(e instanceof EspnError ? e.status : 500, { error: e.message });
  }
  const regCount = league.settings?.scheduleSettings?.matchupPeriodCount || 99;
  const slotCounts = league.settings?.rosterSettings?.lineupSlotCounts;
  if (!slotCounts) return json(500, { error: "Couldn't read the league's lineup settings from ESPN." });

  const byWeek = {};
  for (const g of league.schedule || []) if (g.matchupPeriodId <= regCount) (byWeek[g.matchupPeriodId] ||= []).push(g);
  const done = Object.keys(byWeek).map(Number).filter((w) => byWeek[w].every((g) => g.winner && g.winner !== "UNDECIDED")).sort((a, b) => a - b);

  const store = getStore({ name: "cache", consistency: "strong" });
  let weeks;
  try {
    weeks = await Promise.all(done.map(async (w) => {
      const key = `ifman/v1/w${w}`;
      const cached = await store.get(key, { type: "json" });
      if (cached) return cached;
      const games = await computeWeek(w, slotCounts);
      await store.setJSON(key, games);
      return games;
    }));
  } catch (e) {
    return json(e instanceof EspnError ? e.status : 500, { error: e.message || "Couldn't build the best-lineup standings." });
  }

  const teams = {};
  const t = (id) => (teams[id] ||= { wins: 0, losses: 0, ties: 0, optimalPF: 0, actualPF: 0 });
  weeks.forEach((games) => games.forEach(({ home, away }) => {
    [home, away].forEach((s) => { if (s) { t(s.teamId).optimalPF += s.optimal; t(s.teamId).actualPF += s.actual; } });
    if (!home || !away) return;
    if (home.optimal > away.optimal) { t(home.teamId).wins++; t(away.teamId).losses++; }
    else if (home.optimal < away.optimal) { t(away.teamId).wins++; t(home.teamId).losses++; }
    else { t(home.teamId).ties++; t(away.teamId).ties++; }
  }));
  Object.values(teams).forEach((x) => { x.optimalPF = Math.round(x.optimalPF * 100) / 100; x.actualPF = Math.round(x.actualPF * 100) / 100; });
  return json(200, { weeks: done, teams }, "public, max-age=120");
};

export const config = { path: "/api/ifman" };
