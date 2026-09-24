// Per-team results for every finished regular-season week, cached in Netlify Blobs.
// Used by the If man standings and the Awards tab.
import { getStore } from "@netlify/blobs";
import { espnFetch, leagueUrl } from "./espn.mjs";
import { isStarter, optimalPoints, parsePlayer, rosterOf } from "./model.mjs";

const r2 = (n) => Math.round((n || 0) * 100) / 100;

// One week: each team's actual score, ESPN pre-game projection, best-possible score, and result.
export async function weekSummary(week, slotCounts) {
  const league = JSON.parse(await espnFetch(leagueUrl(["mMatchupScore", "mScoreboard"], week)));
  const games = (league.schedule || []).filter((g) => g.matchupPeriodId === week);
  const teams = [];
  for (const g of games) {
    for (const [s, o, key] of [[g.home, g.away, "HOME"], [g.away, g.home, "AWAY"]]) {
      if (!s) continue;
      const players = rosterOf(s).map((e) => parsePlayer(e, week));
      const starters = players.filter(isStarter);
      const actual = s.totalPoints ?? starters.reduce((a, p) => a + p.actual, 0);
      teams.push({
        teamId: s.teamId,
        oppId: o ? o.teamId : null,
        actual: r2(actual),
        projected: r2(starters.reduce((a, p) => a + p.espnProj, 0)),
        optimal: players.length ? Math.max(r2(actual), optimalPoints(players, slotCounts)) : null,
        result: !o ? "BYE" : g.winner === key ? "W" : g.winner === "TIE" ? "T" : "L",
      });
    }
  }
  return teams;
}

export async function loadSeason() {
  const league = JSON.parse(await espnFetch(leagueUrl(["mMatchupScore", "mSettings", "mStatus"])));
  const regCount = league.settings?.scheduleSettings?.matchupPeriodCount || 99;
  const slotCounts = league.settings?.rosterSettings?.lineupSlotCounts;
  if (!slotCounts) throw new Error("Couldn't read the league's lineup settings from ESPN.");

  const byWeek = {};
  for (const g of league.schedule || []) if (g.matchupPeriodId <= regCount) (byWeek[g.matchupPeriodId] ||= []).push(g);
  const done = Object.keys(byWeek).map(Number)
    .filter((w) => byWeek[w].every((g) => g.winner && g.winner !== "UNDECIDED"))
    .sort((a, b) => a - b);

  const store = getStore({ name: "cache", consistency: "strong" });
  const weeks = await Promise.all(done.map(async (w) => {
    const key = `weeksum/v1/w${w}`;
    let teams = await store.get(key, { type: "json" });
    if (!teams) {
      teams = await weekSummary(w, slotCounts);
      await store.setJSON(key, teams);
    }
    return { week: w, teams };
  }));
  return { league, weeks };
}
