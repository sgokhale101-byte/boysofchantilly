// Live and projected scores for one week, served at /api/week?week=N.
import { EspnError } from "../lib/espn.mjs";
import { computeWeek } from "../lib/model.mjs";

export default async (req) => {
  const week = Number(new URL(req.url).searchParams.get("week"));
  const headers = { "content-type": "application/json" };
  if (!Number.isInteger(week) || week < 1 || week > 30) return new Response(JSON.stringify({ error: "Invalid week." }), { status: 400, headers });
  try {
    const data = await computeWeek(week);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...headers, "cache-control": "public, max-age=20", "netlify-cdn-cache-control": "public, s-maxage=30, stale-while-revalidate=30" },
    });
  } catch (e) {
    const status = e instanceof EspnError ? e.status : 500;
    return new Response(JSON.stringify({ error: e.message || "Couldn't load this week." }), { status, headers: { ...headers, "cache-control": "no-store" } });
  }
};

export const config = { path: "/api/week" };
