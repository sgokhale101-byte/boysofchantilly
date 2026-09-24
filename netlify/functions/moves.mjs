// Completed waivers, free-agent moves, and trades for a week, with player names resolved.
// Served at /api/moves?week=N.
import { BASE, SEASON, LEAGUE_ID, EspnError, espnFetch, leagueUrl } from "../lib/espn.mjs";
import { POS } from "../lib/model.mjs";

const json = (status, obj, cache = "no-store") => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": cache },
});

// ESPN team defenses have ids of 16000 + the NFL team number (sometimes negative).
const NFL = { 1: "Falcons", 2: "Bills", 3: "Bears", 4: "Bengals", 5: "Browns", 6: "Cowboys", 7: "Broncos", 8: "Lions", 9: "Packers", 10: "Titans",
  11: "Colts", 12: "Chiefs", 13: "Raiders", 14: "Rams", 15: "Dolphins", 16: "Vikings", 17: "Patriots", 18: "Saints", 19: "Giants", 20: "Jets",
  21: "Eagles", 22: "Cardinals", 23: "Steelers", 24: "Chargers", 25: "49ers", 26: "Seahawks", 27: "Buccaneers", 28: "Commanders", 29: "Panthers",
  30: "Jaguars", 33: "Ravens", 34: "Texans" };
function defense(id) {
  const n = Math.abs(Number(id)) - 16000;
  return NFL[n] ? { name: `${NFL[n]} D/ST`, pos: "" } : null;
}

// Look players up by id through the league's player endpoint.
async function lookupFantasy(ids) {
  const filter = { players: { filterIds: { value: ids }, limit: ids.length } };
  const url = `${BASE}/${SEASON}/segments/0/leagues/${LEAGUE_ID}?view=kona_player_info&scoringPeriodId=0`;
  const data = JSON.parse(await espnFetch(url, { "X-Fantasy-Filter": JSON.stringify(filter) }));
  const out = {};
  for (const p of data.players || []) {
    const pl = p.player || p;
    if (pl?.id != null && pl.fullName) out[pl.id] = { name: pl.fullName, pos: POS[pl.defaultPositionId] || "" };
  }
  return out;
}

// Fallback: ESPN's public athlete pages use the same ids as fantasy.
async function lookupAthlete(id) {
  try {
    const r = await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const a = (await r.json()).athlete;
    return a?.displayName ? { name: a.displayName, pos: a.position?.abbreviation || "" } : null;
  } catch { return null; }
}

export default async (req) => {
  const week = Number(new URL(req.url).searchParams.get("week"));
  if (!Number.isInteger(week) || week < 1 || week > 30) return json(400, { error: "Invalid week." });
  let data;
  try {
    data = JSON.parse(await espnFetch(leagueUrl(["mTransactions2"], week)));
  } catch (e) {
    return json(e instanceof EspnError ? e.status : 500, { error: e.message });
  }
  const txs = (data.transactions || [])
    .filter((t) => t.status === "EXECUTED" && ["WAIVER", "FREEAGENT", "TRADE_ACCEPT"].includes(t.type))
    .sort((a, b) => (b.processDate || b.proposedDate || 0) - (a.processDate || a.proposedDate || 0));

  const ids = [...new Set(txs.flatMap((t) => (t.items || []).filter((i) => i.type !== "LINEUP").map((i) => i.playerId)))];
  let names = {};
  if (ids.length) {
    try { names = await lookupFantasy(ids); } catch { names = {}; }
    ids.forEach((id) => { if (!names[id]) { const d = defense(id); if (d) names[id] = d; } });
    const missing = ids.filter((id) => !names[id] && id > 0).slice(0, 40);
    const found = await Promise.all(missing.map(lookupAthlete));
    missing.forEach((id, i) => { if (found[i]) names[id] = found[i]; });
  }

  const moves = txs.map((t) => ({
    type: t.type, teamId: t.teamId, bid: t.bidAmount || 0, date: t.processDate || t.proposedDate,
    items: (t.items || []).filter((i) => i.type !== "LINEUP").map((i) => ({
      type: i.type, fromTeamId: i.fromTeamId, toTeamId: i.toTeamId,
      player: names[i.playerId] || { name: `Player ${i.playerId}`, pos: "" },
    })),
  }));
  return json(200, { week, moves }, "public, max-age=60");
};

export const config = { path: "/api/moves" };
