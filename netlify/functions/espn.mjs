// Server-side proxy for ESPN's fantasy API.
// The browser can't call ESPN directly (CORS, and a private league needs
// login cookies), so the page calls /api/espn and this function forwards it.

const LEAGUE_ID = process.env.ESPN_LEAGUE_ID || "353576";
const SEASON = process.env.ESPN_SEASON || "2026";
const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

const ALLOWED_VIEWS = new Set([
  "mSettings", "mTeam", "mStandings", "mMatchup", "mMatchupScore",
  "mScoreboard", "mStatus", "mTransactions2", "mRoster", "mNav",
]);

function json(status, obj, cache = "no-store") {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": cache },
  });
}

function espnHeaders() {
  const headers = { Accept: "application/json", "User-Agent": "boys-of-chantilly-dashboard" };
  const s2 = process.env.ESPN_S2;
  let swid = process.env.SWID;
  if (s2 && swid) {
    swid = swid.trim();
    if (!swid.startsWith("{")) swid = `{${swid}}`; // SWID must keep its braces
    headers.Cookie = `espn_s2=${s2.trim()}; SWID=${swid}`;
  }
  return headers;
}

export default async (req) => {
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") || "league";
  let target;

  if (kind === "players") {
    target = `${BASE}/${SEASON}/players?scoringPeriodId=0&view=players_wl`;
  } else if (kind === "league") {
    const views = url.searchParams.getAll("view").filter((v) => ALLOWED_VIEWS.has(v));
    if (!views.length) return json(400, { error: "No valid view requested." });
    const qs = new URLSearchParams();
    views.forEach((v) => qs.append("view", v));
    const sp = url.searchParams.get("scoringPeriodId");
    if (sp && /^\d{1,2}$/.test(sp)) qs.set("scoringPeriodId", sp);
    target = `${BASE}/${SEASON}/segments/0/leagues/${LEAGUE_ID}?${qs}`;
  } else {
    return json(400, { error: "Unknown request type." });
  }

  let res;
  try {
    res = await fetch(target, { headers: espnHeaders(), redirect: "manual" });
  } catch (e) {
    return json(502, { error: "Couldn't reach ESPN. Try again in a minute." });
  }

  const type = res.headers.get("content-type") || "";
  const hasCookies = Boolean(process.env.ESPN_S2 && process.env.SWID);

  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400) || !type.includes("json")) {
    return json(401, {
      error: hasCookies
        ? "ESPN rejected the saved login cookies. They may have expired: copy fresh espn_s2 and SWID values into Netlify's environment variables, then redeploy."
        : "This is a private league, so ESPN needs login cookies. Add ESPN_S2 and SWID in Netlify's environment variables, then redeploy.",
    });
  }
  if (!res.ok) return json(res.status, { error: `ESPN returned an error (${res.status}).` });

  const body = await res.text();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": kind === "players" ? "public, max-age=21600" : "public, max-age=20",
    },
  });
};

export const config = { path: "/api/espn" };
