// Draft recap for any season, served at /api/draft?season=YYYY.
// Steals and busts compare where a player was drafted among his position with where he finished
// among drafted players at his position (kickers and defenses left out).
import { getStore } from "@netlify/blobs";
import { BASE, SEASON, EspnError, espnFetch, seasonLeague } from "../lib/espn.mjs";
import { POS } from "../lib/model.mjs";

const json = (status, obj, cache = "no-store") => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": cache },
});
const r2 = (n) => Math.round((n || 0) * 100) / 100;
const SKIP = new Set(["K", "D/ST"]);

// ESPN team defenses have ids of 16000 + the NFL team number (sometimes negative).
const NFL = { 1: "Falcons", 2: "Bills", 3: "Bears", 4: "Bengals", 5: "Browns", 6: "Cowboys", 7: "Broncos", 8: "Lions", 9: "Packers", 10: "Titans",
  11: "Colts", 12: "Chiefs", 13: "Raiders", 14: "Rams", 15: "Dolphins", 16: "Vikings", 17: "Patriots", 18: "Saints", 19: "Giants", 20: "Jets",
  21: "Eagles", 22: "Cardinals", 23: "Steelers", 24: "Chargers", 25: "49ers", 26: "Seahawks", 27: "Buccaneers", 28: "Commanders", 29: "Panthers",
  30: "Jaguars", 33: "Ravens", 34: "Texans" };
const defense = (id) => { const n = Math.abs(Number(id)) - 16000; return NFL[n] ? `${NFL[n]} D/ST` : null; };

async function athlete(id) {
  try {
    const r = await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const a = (await r.json()).athlete;
    return a?.displayName ? { name: a.displayName, pos: a.position?.abbreviation || "" } : null;
  } catch { return null; }
}

function memberName(m) {
  if (!m) return "";
  return m.firstName || m.displayName || "";
}

function seasonPoints(p, year) {
  let best = null;
  for (const s of p.stats || []) {
    if (s.statSourceId !== 0 || s.scoringPeriodId !== 0) continue;
    if (s.seasonId != null && Number(s.seasonId) !== Number(year)) continue;
    if (s.statSplitTypeId != null && s.statSplitTypeId !== 0) continue;
    best = s.appliedTotal ?? best;
  }
  return best;
}

async function buildDraft(year) {
  const L = await seasonLeague(year, ["mDraftDetail", "mTeam", "mSettings"]);
  const picks = L.draftDetail?.picks || [];
  if (!picks.length) return { year, available: false, reason: "ESPN has no draft picks for this season." };

  const teams = {};
  const members = {};
  (L.members || []).forEach((m) => (members[m.id] = memberName(m)));
  for (const t of L.teams || []) teams[t.id] = { name: t.name || `${t.location || ""} ${t.nickname || ""}`.trim(), manager: members[t.primaryOwner || (t.owners || [])[0]] || "" };

  // Player names and season points, 50 at a time, from the league's player data.
  const ids = [...new Set(picks.map((p) => p.playerId))];
  const info = {};
  let statsOk = true;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const filter = { players: { filterIds: { value: chunk }, limit: chunk.length } };
    try {
      const data = await seasonLeague(year, ["kona_player_info"], 0, { "X-Fantasy-Filter": JSON.stringify(filter) });
      for (const x of data.players || []) {
        const p = x.player || x;
        if (p?.id == null) continue;
        info[p.id] = { name: p.fullName || null, pos: POS[p.defaultPositionId] || "", points: seasonPoints(p, year) };
      }
    } catch { statsOk = false; }
  }
  // Backup 1: ESPN's season player list (names and positions).
  let missing = ids.filter((id) => !info[id]?.name);
  if (missing.length) {
    try {
      const filter = { filterIds: { value: missing } };
      const list = JSON.parse(await espnFetch(`${BASE}/${year}/players?scoringPeriodId=0&view=players_wl`, { "X-Fantasy-Filter": JSON.stringify(filter) }));
      for (const p of Array.isArray(list) ? list : []) {
        if (p?.id == null || !p.fullName) continue;
        info[p.id] = { ...(info[p.id] || { points: null }), name: p.fullName, pos: info[p.id]?.pos || POS[p.defaultPositionId] || "" };
      }
    } catch {}
  }
  // Backup 2: team defenses by id, then individual ESPN player pages.
  missing = ids.filter((id) => !info[id]?.name);
  for (const id of missing) { const d = defense(id); if (d) info[id] = { ...(info[id] || { points: null }), name: d, pos: "D/ST" }; }
  missing = ids.filter((id) => !info[id]?.name && id > 0);
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const found = await Promise.all(chunk.map(athlete));
    chunk.forEach((id, k) => { if (found[k]) info[id] = { ...(info[id] || { points: null }), name: found[k].name, pos: info[id]?.pos || found[k].pos }; });
  }
  const namesFound = ids.filter((id) => info[id]?.name).length;

  const auction = picks.some((p) => (p.bidAmount || 0) > 0);
  const rows = picks.map((p) => ({
    overall: p.overallPickNumber, round: p.roundId, roundPick: p.roundPickNumber, teamId: p.teamId,
    bid: p.bidAmount || 0, keeper: Boolean(p.keeper),
    playerId: p.playerId, name: info[p.playerId]?.name || `Player ${p.playerId}`, pos: info[p.playerId]?.pos || "",
    points: info[p.playerId]?.points ?? null,
  })).sort((a, b) => a.overall - b.overall);

  // Rank within position: draft order (or price, for auctions) vs. points scored.
  const byPos = {};
  rows.forEach((r) => (byPos[r.pos] ||= []).push(r));
  for (const [pos, list] of Object.entries(byPos)) {
    [...list].sort((a, b) => auction ? b.bid - a.bid || a.overall - b.overall : a.overall - b.overall).forEach((r, i) => (r.posDraftRank = i + 1));
    [...list].sort((a, b) => (b.points ?? -1) - (a.points ?? -1)).forEach((r, i) => (r.posFinishRank = r.points == null ? null : i + 1));
    list.forEach((r) => (r.value = r.posFinishRank == null ? null : r.posDraftRank - r.posFinishRank));
  }
  const eligible = rows.filter((r) => !SKIP.has(r.pos) && r.value != null && r.pos);
  const steals = [...eligible].filter((r) => r.value > 0).sort((a, b) => b.value - a.value || (b.points - a.points)).slice(0, 5);
  const earlyCut = Object.keys(teams).length * 4; // first four rounds (or the top-priced players at auction)
  const early = eligible.filter((r) => (auction ? r.posDraftRank <= 12 : r.overall <= earlyCut));
  const busts = [...early].filter((r) => r.value < 0).sort((a, b) => a.value - b.value || (a.points - b.points)).slice(0, 5);

  return {
    year, available: true, auction, complete: Number(year) < Number(SEASON), statsAvailable: statsOk && rows.some((r) => r.points != null),
    namesFound, namesTotal: ids.length,
    rounds: Math.max(...rows.map((r) => r.round || 0)), teams, picks: rows,
    steals: steals.map((r) => r.overall), busts: busts.map((r) => r.overall),
  };
}

export default async (req) => {
  const year = Number(new URL(req.url).searchParams.get("season") || SEASON);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return json(400, { error: "Invalid season." });
  const store = getStore({ name: "cache", consistency: "strong" });
  const key = `hist/draft/v2/${year}`;
  try {
    if (year < Number(SEASON)) {
      const hit = await store.get(key, { type: "json" }).catch(() => null);
      if (hit) return json(200, hit, "public, max-age=3600");
    }
    const d = await buildDraft(year);
    if (d.available && d.complete && d.statsAvailable && d.namesFound === d.namesTotal) await store.setJSON(key, d).catch(() => {});
    return json(200, d, d.complete ? "public, max-age=3600" : "public, max-age=900");
  } catch (e) {
    return json(e instanceof EspnError ? e.status : 500, { error: e.message || "Couldn't load the draft." });
  }
};

export const config = { path: "/api/draft" };
