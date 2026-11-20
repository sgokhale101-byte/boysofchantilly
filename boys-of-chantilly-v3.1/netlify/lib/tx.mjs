// Shared transaction helpers: every completed move this season and player-name lookups.
import { getStore } from "@netlify/blobs";
import { BASE, SEASON, LEAGUE_ID, espnFetch, leagueUrl } from "./espn.mjs";
import { POS } from "./model.mjs";

const TYPES = ["WAIVER", "FREEAGENT", "TRADE_ACCEPT"];

// ESPN team defenses have ids of 16000 + the NFL team number (sometimes negative).
const NFL = { 1: "Falcons", 2: "Bills", 3: "Bears", 4: "Bengals", 5: "Browns", 6: "Cowboys", 7: "Broncos", 8: "Lions", 9: "Packers", 10: "Titans",
  11: "Colts", 12: "Chiefs", 13: "Raiders", 14: "Rams", 15: "Dolphins", 16: "Vikings", 17: "Patriots", 18: "Saints", 19: "Giants", 20: "Jets",
  21: "Eagles", 22: "Cardinals", 23: "Steelers", 24: "Chargers", 25: "49ers", 26: "Seahawks", 27: "Buccaneers", 28: "Commanders", 29: "Panthers",
  30: "Jaguars", 33: "Ravens", 34: "Texans" };
export function defense(id) {
  const n = Math.abs(Number(id)) - 16000;
  return NFL[n] ? { name: `${NFL[n]} D/ST`, pos: "" } : null;
}
export async function lookupFantasy(ids) {
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
export async function lookupAthlete(id) {
  try {
    const r = await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const a = (await r.json()).athlete;
    return a?.displayName ? { name: a.displayName, pos: a.position?.abbreviation || "" } : null;
  } catch { return null; }
}

// Every completed move this season. Finished scoring periods are cached since they don't change.
export async function seasonMoves(currentPeriod) {
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


// Names for a set of player ids: league lookup, defenses, then ESPN player pages.
export async function playerNames(ids) {
  let names = {};
  if (!ids.length) return names;
  try { names = await lookupFantasy(ids); } catch { names = {}; }
  ids.forEach((id) => { if (!names[id]) { const d = defense(id); if (d) names[id] = d; } });
  const missing = ids.filter((id) => !names[id] && id > 0).slice(0, 40);
  const found = await Promise.all(missing.map(lookupAthlete));
  missing.forEach((id, i) => { if (found[i]) names[id] = found[i]; });
  return names;
}

// Current period and every completed move so far.
export async function currentMoves(league) {
  const current = league.scoringPeriodId || league.status?.latestScoringPeriod || league.status?.currentMatchupPeriod || 1;
  return seasonMoves(current);
}

// Starting FAAB budgets that differ from the league setting, by manager first name.
export const FAAB_START = { vivek: 110, cameron: 110, srimanth: 110 };
export function startingBudget(team, members, base) {
  const m = (members || []).find((x) => x.id === (team.primaryOwner || (team.owners || [])[0]));
  const first = String(m?.firstName || m?.displayName || "").trim().split(/\s+/)[0].toLowerCase();
  return FAAB_START[first] ?? base;
}

// ESPN's public injury report: is this player out for the season?
export async function outForSeason(id, seasonYear) {
  try {
    const r = await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return false;
    const a = (await r.json()).athlete || {};
    for (const inj of a.injuries || []) {
      const text = `${inj.status || ""} ${inj.shortComment || ""} ${inj.longComment || ""} ${inj.details?.fantasyStatus?.description || ""}`.toLowerCase();
      if (/season[- ]ending|out for (the )?season|for the season|rest of the season/.test(text)) return true;
      const ret = inj.details?.returnDate ? new Date(inj.details.returnDate) : null;
      if (ret && ret > new Date(`${Number(seasonYear) + 1}-01-10`)) return true;
    }
  } catch {}
  return false;
}
