// Weekly recap data, served at /api/recap: every finished week's per-team results
// (score, projection, best lineup, result, starters, bench) for the Story tab's Tuesday recap.
import { EspnError } from "../lib/espn.mjs";
import { loadSeason } from "../lib/season.mjs";

export default async () => {
  const headers = { "content-type": "application/json" };
  try {
    const s = await loadSeason();
    const weeks = s.weeks.map(({ week, teams }) => ({
      week,
      teams: teams.map((t) => ({
        teamId: t.teamId, oppId: t.oppId, actual: t.actual, projected: t.projected, optimal: t.optimal, result: t.result,
        starters: (t.starters || []).map((p) => ({ name: p.name, pos: p.pos, pts: p.pts })),
        bench: (t.bench || []).map((p) => ({ name: p.name, pos: p.pos, pts: p.pts })),
      })),
    }));
    return new Response(JSON.stringify({ weeks }), { status: 200, headers: { ...headers, "cache-control": "public, max-age=300" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "Couldn't build the recap." }), { status: e instanceof EspnError ? e.status : 500, headers: { ...headers, "cache-control": "no-store" } });
  }
};

export const config = { path: "/api/recap" };
