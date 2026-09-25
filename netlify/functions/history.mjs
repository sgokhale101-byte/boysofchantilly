// League history, served at /api/history.
//   ?part=summary          -> every season: managers, finishes, records
//   ?part=ifman&season=Y   -> best-lineup records for one season (may need a few calls on first run)
//   ?part=players&season=Y -> top individual player performances for one season
import { EspnError } from "../lib/espn.mjs";
import { allSeasons, seasonIfMan, seasonPlayers } from "../lib/history.mjs";

const json = (status, obj, cache = "no-store") => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": cache },
});

export default async (req) => {
  const url = new URL(req.url);
  const part = url.searchParams.get("part") || "summary";
  try {
    if (part === "summary") {
      const seasons = await allSeasons();
      return json(200, { seasons }, "public, max-age=300");
    }
    if (part === "ifman") {
      const year = Number(url.searchParams.get("season"));
      if (!Number.isInteger(year) || year < 2000 || year > 2100) return json(400, { error: "Invalid season." });
      const r = await seasonIfMan(year, Date.now() + 6500);
      return json(200, r, r.complete ? "public, max-age=600" : "no-store");
    }
    if (part === "players") {
      const year = Number(url.searchParams.get("season"));
      if (!Number.isInteger(year) || year < 2000 || year > 2100) return json(400, { error: "Invalid season." });
      const r = await seasonPlayers(year, Date.now() + 6500);
      return json(200, r, r.complete ? "public, max-age=600" : "no-store");
    }
    return json(400, { error: "Unknown request." });
  } catch (e) {
    return json(e instanceof EspnError ? e.status : 500, { error: e.message || "Couldn't load league history." });
  }
};

export const config = { path: "/api/history" };
