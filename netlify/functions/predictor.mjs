// Playoff Predictor data, served at /api/predictor: remaining regular-season schedule with projected scores.
// Recomputed on every open (a short CDN cache keeps a burst of opens from hammering ESPN).
import { EspnError } from "../lib/espn.mjs";
import { predict } from "../lib/predictor.mjs";

export default async () => {
  const headers = { "content-type": "application/json" };
  try {
    const data = await predict();
    return new Response(JSON.stringify(data), { status: 200, headers: { ...headers, "cache-control": "no-store", "netlify-cdn-cache-control": "public, s-maxage=60, stale-while-revalidate=60" } });
  } catch (e) {
    const status = e instanceof EspnError ? e.status : 500;
    return new Response(JSON.stringify({ error: e.message || "Couldn't build the predictor." }), { status, headers: { ...headers, "cache-control": "no-store" } });
  }
};

export const config = { path: "/api/predictor" };
