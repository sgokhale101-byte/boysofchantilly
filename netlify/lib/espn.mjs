// Shared ESPN helpers used by the espn and picks functions.
export const LEAGUE_ID = process.env.ESPN_LEAGUE_ID || "353576";
export const SEASON = process.env.ESPN_SEASON || "2026";
export const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

export function espnHeaders() {
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

export class EspnError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Fetch from ESPN and return parsed JSON, or throw EspnError with a readable message.
export async function espnFetch(target, extraHeaders = {}) {
  let res;
  try {
    res = await fetch(target, { headers: { ...espnHeaders(), ...extraHeaders }, redirect: "manual" });
  } catch {
    throw new EspnError(502, "Couldn't reach ESPN. Try again in a minute.");
  }
  const type = res.headers.get("content-type") || "";
  const hasCookies = Boolean(process.env.ESPN_S2 && process.env.SWID);
  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400) || !type.includes("json")) {
    throw new EspnError(401, hasCookies
      ? "ESPN rejected the saved login cookies. They may have expired: copy fresh espn_s2 and SWID values into Netlify's environment variables, then redeploy."
      : "This is a private league, so ESPN needs login cookies. Add ESPN_S2 and SWID in Netlify's environment variables, then redeploy.");
  }
  if (!res.ok) throw new EspnError(res.status, `ESPN returned an error (${res.status}).`);
  return res.text();
}

export function leagueUrl(views, scoringPeriodId) {
  const qs = new URLSearchParams();
  views.forEach((v) => qs.append("view", v));
  if (scoringPeriodId) qs.set("scoringPeriodId", String(scoringPeriodId));
  return `${BASE}/${SEASON}/segments/0/leagues/${LEAGUE_ID}?${qs}`;
}

export const sidePoints = (s) => (s ? (s.totalPointsLive ?? s.totalPoints ?? 0) : 0);

// Any season of this league. ESPN serves 2018 and later from the normal endpoint and
// earlier seasons from leagueHistory (which returns an array).
export function seasonUrl(year, views, scoringPeriodId) {
  const qs = new URLSearchParams();
  views.forEach((v) => qs.append("view", v));
  if (scoringPeriodId) qs.set("scoringPeriodId", String(scoringPeriodId));
  if (Number(year) >= 2018) return `${BASE}/${year}/segments/0/leagues/${LEAGUE_ID}?${qs}`;
  return `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/leagueHistory/${LEAGUE_ID}?seasonId=${year}&${qs}`;
}
export async function seasonLeague(year, views, scoringPeriodId) {
  const j = JSON.parse(await espnFetch(seasonUrl(year, views, scoringPeriodId)));
  return Array.isArray(j) ? j[0] : j;
}
