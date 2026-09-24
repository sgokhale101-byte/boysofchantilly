// Server-side proxy for ESPN's fantasy API, served at /api/espn.
import { BASE, SEASON, EspnError, espnFetch, leagueUrl } from "../lib/espn.mjs";

const ALLOWED_VIEWS = new Set([
  "mSettings", "mTeam", "mStandings", "mMatchup", "mMatchupScore",
  "mScoreboard", "mStatus", "mTransactions2", "mRoster", "mNav",
]);

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

export default async (req) => {
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") || "league";
  let target;
  if (kind === "players") {
    target = `${BASE}/${SEASON}/players?scoringPeriodId=0&view=players_wl`;
  } else if (kind === "league") {
    const views = url.searchParams.getAll("view").filter((v) => ALLOWED_VIEWS.has(v));
    if (!views.length) return json(400, { error: "No valid view requested." });
    const sp = url.searchParams.get("scoringPeriodId");
    target = leagueUrl(views, sp && /^\d{1,2}$/.test(sp) ? sp : null);
  } else {
    return json(400, { error: "Unknown request type." });
  }
  try {
    const body = await espnFetch(target);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": kind === "players" ? "public, max-age=21600" : "public, max-age=20",
      },
    });
  } catch (e) {
    if (e instanceof EspnError) return json(e.status, { error: e.message });
    return json(500, { error: "Something went wrong loading ESPN data." });
  }
};

export const config = { path: "/api/espn" };
