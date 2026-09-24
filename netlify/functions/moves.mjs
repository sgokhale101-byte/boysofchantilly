// Completed waivers, free-agent moves, and trades for a week, with player names resolved
// and each team's FAAB left after every move. Served at /api/moves?week=N.
import { getStore } from "@netlify/blobs";
import { BASE, SEASON, LEAGUE_ID, EspnError, espnFetch, leagueUrl } from "../lib/espn.mjs";
import { POS } from "../lib/model.mjs";

const json = (status, obj, cache = "no-store") => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": cache },
});
const TYPES = ["WAIVER", "FREEAGENT", "TRADE_ACCEPT"];

// ESPN team defenses have ids of 16000 + the NFL team number (sometimes negative).
const NFL = { 1: "Falcons", 2: "Bills", 3: "Bears", 4: "Bengals", 5: "Browns", 6: "Cowboys", 7: "Broncos", 8: "Lions", 9: "Packers", 10: "Titans",
  11: "Colts", 12: "Chiefs", 13: "Raiders", 14: "Rams", 15: "Dolphins", 16: "Vikings", 17: "Patriots", 18: "Saints", 19: "Giants", 20: "Jets",
  21: "Eagles", 22: "Cardinals", 23: "Steelers", 24: "Chargers", 25: "49ers", 26: "Seahawks", 27: "Buccaneers", 28: "Commanders", 29: "Panthers",
  30: "Jaguars", 33: "Ravens", 34: "Texans" };
function defense(id) {
  const n = Math.abs(Number(id)) - 16000;
  return NFL[n] ? { name: `${NFL[n]} D/ST`, pos: "" } : null;
}
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
async function lookupAthlete(id) {
  try {
    const r = await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const a = (await r.json()).athlete;
    return a?.displayName ? { name: a.displayName, pos: a.position?.abbreviation || "" } : null;
  } catch { return null; }
}

// Every completed move this season. Finished scoring periods are cached since they don't change.
async function seasonMoves(currentPeriod) {
  const store = getStore({ name: "cache", consistency: "strong" });
  const periods = Array.from({ length: Math.max(1, currentPeriod) }, (_, i) => i + 1);
  const lists = await Promise.all(periods.map(async (p) => {
    const key = `tx/v1/p${p}`;
    if (p < currentPeriod) {
      const hit = await store.get(key, { type: "json" }).catch(() => null);
      if (hit) return hit;
    }
    const data = JSON.parse(await espnFetch(leagueUrl(["mTransactions2"], p)));
    const txs = (data.transactions || []).filter((t) => t.status === "EXECUTED" && TYPES.includes(t.type))
      .map((t) => ({
        id: t.id, period: t.scoringPeriodId ?? p, type: t.type, teamId: t.teamId, bid: t.bidAmount || 0,
        date: t.processDate || t.proposedDate || 0,
        items: (t.items || []).filter((i) => i.type !== "LINEUP").map((i) => ({ type: i.type, playerId: i.playerId, fromTeamId: i.fromTeamId, toTeamId: i.toTeamId })),
      }));
    if (p < currentPeriod) await store.setJSON(key, txs).catch(() => {});
    return txs;
  }));
  const seen = new Set();
  return lists.flat().filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));
}

export default async (req) => {
  const week = Number(new URL(req.url).searchParams.get("week"));
  if (!Number.isInteger(week) || week < 1 || week > 30) return json(400, { error: "Invalid week." });

  let league, all;
  try {
    league = JSON.parse(await espnFetch(leagueUrl(["mSettings", "mTeam", "mStatus"])));
    const current = league.scoringPeriodId || league.status?.latestScoringPeriod || league.status?.currentMatchupPeriod || week;
    all = await seasonMoves(Math.max(current, week));
  } catch (e) {
    return json(e instanceof EspnError ? e.status : 500, { error: e.message });
  }

  // FAAB: anchor on what ESPN says each team has spent, then add back bids made after each move.
  const acq = league.settings?.acquisitionSettings || {};
  const budget = acq.acquisitionBudget || 0;
  const usesFaab = budget > 0 && acq.isUsingAcquisitionBudget !== false;
  const leftNow = {};
  for (const t of league.teams || []) {
    const spentEspn = t.transactionCounter?.acquisitionBudgetSpent;
    const spentHere = all.filter((x) => x.type === "WAIVER" && x.teamId === t.id).reduce((a, x) => a + x.bid, 0);
    leftNow[t.id] = budget - (spentEspn ?? spentHere);
  }
  const chrono = [...all].sort((a, b) => a.date - b.date || a.id.localeCompare?.(b.id) || 0);
  const leftAfter = (tx, teamId) => {
    const idx = chrono.indexOf(tx);
    const later = chrono.slice(idx + 1).filter((x) => x.type === "WAIVER" && x.teamId === teamId).reduce((a, x) => a + x.bid, 0);
    return leftNow[teamId] + later;
  };

  const weekTx = all.filter((t) => t.period === week).sort((a, b) => b.date - a.date);
  const ids = [...new Set(weekTx.flatMap((t) => t.items.map((i) => i.playerId)))];
  let names = {};
  if (ids.length) {
    try { names = await lookupFantasy(ids); } catch { names = {}; }
    ids.forEach((id) => { if (!names[id]) { const d = defense(id); if (d) names[id] = d; } });
    const missing = ids.filter((id) => !names[id] && id > 0).slice(0, 40);
    const found = await Promise.all(missing.map(lookupAthlete));
    missing.forEach((id, i) => { if (found[i]) names[id] = found[i]; });
  }

  const moves = weekTx.map((t) => {
    const teams = t.type === "TRADE_ACCEPT"
      ? [...new Set(t.items.flatMap((i) => [i.fromTeamId, i.toTeamId]))].filter((id) => id != null && id >= 0)
      : [t.teamId];
    return {
      type: t.type, teamId: t.teamId, bid: t.bid, date: t.date,
      faabLeft: usesFaab ? Object.fromEntries(teams.map((id) => [id, leftAfter(t, id)])) : null,
      items: t.items.map((i) => ({ type: i.type, fromTeamId: i.fromTeamId, toTeamId: i.toTeamId, player: names[i.playerId] || { name: `Player ${i.playerId}`, pos: "" } })),
    };
  });
  return json(200, { week, budget: usesFaab ? budget : null, moves }, "public, max-age=60");
};

export const config = { path: "/api/moves" };
