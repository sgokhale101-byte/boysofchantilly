// Weekly awards for every finished week, served at /api/awards.
import { EspnError } from "../lib/espn.mjs";
import { loadSeason } from "../lib/season.mjs";

const json = (status, obj, cache = "no-store") => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": cache, ...(status === 200 ? { "netlify-cdn-cache-control": "public, s-maxage=300" } : {}) },
});
const r2 = (n) => Math.round(n * 100) / 100;

// Every team tied for the best value wins (co-winners).
function pick(rows, score, better) {
  let best = null, winners = [];
  for (const r of rows) {
    const v = score(r);
    if (v == null || Number.isNaN(v)) continue;
    if (best == null || better(v, best)) { best = v; winners = [r]; }
    else if (Math.abs(v - best) < 0.005) winners.push(r);
  }
  return winners.length ? { value: r2(best), winners } : null;
}
const hi = (a, b) => a > b + 0.005, lo = (a, b) => a < b - 0.005;
// Several perfect lineups: the higher score takes it.
function tieBreak(p) {
  if (!p || p.winners.length < 2) return p;
  const top = Math.max(...p.winners.map((r) => r.actual));
  return { value: p.value, winners: p.winners.filter((r) => Math.abs(r.actual - top) < 0.005) };
}

export default async () => {
  let season;
  try { season = await loadSeason(); }
  catch (e) { return json(e instanceof EspnError ? e.status : 500, { error: e.message || "Couldn't build the awards." }); }

  const weeks = season.weeks.map(({ week, teams }) => {
    const hasProj = teams.some((t) => t.projected > 0);
    const hasOpt = teams.some((t) => t.optimal != null);
    const fmtWin = (p, extra) => p && { value: p.value, winners: p.winners.map((r) => ({ teamId: r.teamId, actual: r.actual, projected: r.projected, optimal: r.optimal, oppId: r.oppId, ...extra?.(r) })) };
    const opp = (r) => teams.find((t) => t.teamId === r.oppId);
    return {
      week,
      high: fmtWin(pick(teams, (t) => t.actual, hi)),
      low: fmtWin(pick(teams, (t) => t.actual, lo)),
      awards: {
        overperformer: hasProj ? fmtWin(pick(teams, (t) => t.projected > 0 ? t.actual - t.projected : null, hi)) : null,
        letdown: hasProj ? fmtWin(pick(teams, (t) => t.projected > 0 ? t.actual - t.projected : null, lo)) : null,
        manager: hasOpt ? fmtWin(tieBreak(pick(teams, (t) => t.optimal != null ? t.optimal - t.actual : null, lo))) : null,
        noah: fmtWin(pick(teams.filter((t) => t.result === "L"), (t) => t.actual, hi), (r) => ({ oppScore: opp(r)?.actual })),
        srimanth: fmtWin(pick(teams.filter((t) => t.result === "W"), (t) => t.actual, lo), (r) => ({ oppScore: opp(r)?.actual })),
      },
    };
  });

  return json(200, { weeks }, "public, max-age=120");
};

export const config = { path: "/api/awards" };
