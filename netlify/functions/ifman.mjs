// "If man" standings: every team starts its best possible lineup each finished week.
// Served at /api/ifman.
import { EspnError } from "../lib/espn.mjs";
import { loadSeason } from "../lib/season.mjs";
import { median } from "../lib/model.mjs";

const json = (status, obj, cache = "no-store") => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": cache, ...(status === 200 ? { "netlify-cdn-cache-control": "public, s-maxage=300" } : {}) },
});

export default async () => {
  let season;
  try { season = await loadSeason(); }
  catch (e) { return json(e instanceof EspnError ? e.status : 500, { error: e.message || "Couldn't build the best-lineup standings." }); }

  const teams = {};
  const t = (id) => (teams[id] ||= { h2h: { w: 0, l: 0, t: 0 }, median: { w: 0, l: 0, t: 0 }, optimalPF: 0, actualPF: 0 });
  for (const { teams: rows } of season.weeks) {
    const best = (r) => r.optimal ?? r.actual;
    const byId = Object.fromEntries(rows.map((r) => [r.teamId, r]));
    const med = median(rows.map(best));
    for (const r of rows) {
      const x = t(r.teamId);
      x.optimalPF += best(r); x.actualPF += r.actual;
      const o = r.oppId != null ? byId[r.oppId] : null;
      if (o) { const a = best(r), b = best(o); a > b ? x.h2h.w++ : a < b ? x.h2h.l++ : x.h2h.t++; }
      best(r) > med ? x.median.w++ : best(r) < med ? x.median.l++ : x.median.t++;
    }
  }
  Object.values(teams).forEach((x) => { x.optimalPF = Math.round(x.optimalPF * 100) / 100; x.actualPF = Math.round(x.actualPF * 100) / 100; });
  return json(200, { weeks: season.weeks.map((w) => w.week), teams }, "public, max-age=120");
};

export const config = { path: "/api/ifman" };
