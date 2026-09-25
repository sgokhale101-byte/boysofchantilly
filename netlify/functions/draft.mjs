// Draft recap for any season, served at /api/draft?season=YYYY.
// Steals and busts compare where a player was drafted among his position with where he finished
// among drafted players at his position (kickers and defenses left out).
import { getStore } from "@netlify/blobs";
import { BASE, SEASON, EspnError, espnFetch, seasonLeague } from "../lib/espn.mjs";
import { POS } from "../lib/model.mjs";
import { seasonHalfPpr, HALF_PPR_NOTE } from "../lib/halfppr.mjs";

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

  // Names and positions from the league's player data first.
  const ids = [...new Set(picks.map((p) => p.playerId))];
  const info = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const filter = { players: { filterIds: { value: chunk }, limit: chunk.length } };
    try {
      const data = await seasonLeague(year, ["kona_player_info"], 0, { "X-Fantasy-Filter": JSON.stringify(filter) });
      for (const x of data.players || []) {
        const p = x.player || x;
        if (p?.id != null) info[p.id] = { name: p.fullName || null, pos: POS[p.defaultPositionId] || "" };
      }
    } catch {}
  }
  // Half-PPR points from raw stats (public ESPN data), plus the season's top players at each position.
  const hp = await seasonHalfPpr(year, ids);
  for (const id of ids) {
    const h = hp.players[id];
    info[id] = { name: info[id]?.name || h?.name || null, pos: info[id]?.pos || h?.pos || "", points: h?.points ?? null };
  }
  // Remaining names: season player list, defenses by id, then ESPN player pages.
  let missing = ids.filter((id) => !info[id]?.name);
  if (missing.length) {
    try {
      const list = JSON.parse(await espnFetch(`${BASE}/${year}/players?scoringPeriodId=0&view=players_wl`, { "X-Fantasy-Filter": JSON.stringify({ filterIds: { value: missing } }) }));
      for (const p of Array.isArray(list) ? list : []) if (p?.id != null && p.fullName && info[p.id]) { info[p.id].name = p.fullName; info[p.id].pos ||= POS[p.defaultPositionId] || ""; }
    } catch {}
  }
  for (const id of ids.filter((x) => !info[x]?.name)) { const d = defense(id); if (d) Object.assign(info[id], { name: d, pos: "D/ST" }); }
  missing = ids.filter((id) => !info[id]?.name && id > 0);
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const found = await Promise.all(chunk.map(athlete));
    chunk.forEach((id, k) => { if (found[k]) { info[id].name = found[k].name; info[id].pos ||= found[k].pos; } });
  }
  const namesFound = ids.filter((id) => info[id]?.name).length;

  const auction = picks.some((p) => (p.bidAmount || 0) > 0);
  const rows = picks.map((p) => ({
    overall: p.overallPickNumber, round: p.roundId, roundPick: p.roundPickNumber, teamId: p.teamId,
    bid: p.bidAmount || 0, keeper: Boolean(p.keeper),
    playerId: p.playerId, name: info[p.playerId]?.name || `Player ${p.playerId}`, pos: info[p.playerId]?.pos || "",
    points: info[p.playerId]?.points ?? null,
  })).sort((a, b) => a.overall - b.overall);

  // Draft rank: order taken at the position (or price paid, at auction).
  // Finish rank: half-PPR points among every player at the position we have points for
  // (drafted players plus the season's top 80 at QB, RB, WR, and TE).
  const byPos = {};
  rows.forEach((r) => (byPos[r.pos] ||= []).push(r));
  const universe = {};
  for (const [id, h] of Object.entries(hp.players)) if (h.points != null && h.pos) (universe[h.pos] ||= new Map()).set(Number(id), h.points);
  for (const [pos, list] of Object.entries(byPos)) {
    [...list].sort((a, b) => auction ? b.bid - a.bid || a.overall - b.overall : a.overall - b.overall).forEach((r, i) => (r.posDraftRank = i + 1));
    const pts = universe[pos] || new Map();
    list.forEach((r) => { if (r.points != null) pts.set(r.playerId, r.points); });
    const order = [...pts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    list.forEach((r) => {
      const i = order.indexOf(r.playerId);
      r.posFinishRank = r.points == null || i < 0 ? null : i + 1;
      r.value = r.posFinishRank == null ? null : r.posDraftRank - r.posFinishRank;
    });
  }
  const eligible = rows.filter((r) => !SKIP.has(r.pos) && r.value != null && r.pos);
  const teamCount = Object.keys(teams).length || 10;
  const isEarly = (r) => (auction ? r.posDraftRank <= 12 : r.round <= 4);
  const steals = [...eligible].filter((r) => r.value > 0).sort((a, b) => b.value - a.value || b.points - a.points).slice(0, 5);
  const busts = [...eligible].filter((r) => isEarly(r) && r.value < 0).sort((a, b) => a.value - b.value || a.points - b.points).slice(0, 5);

  // Each manager's best steal and worst bust.
  const perTeam = {};
  for (const id of Object.keys(teams).map(Number)) {
    const mine = eligible.filter((r) => r.teamId === id);
    const st = [...mine].filter((r) => r.value > 0).sort((a, b) => b.value - a.value || b.points - a.points)[0];
    const bu = [...mine].filter((r) => r.round <= 6 && r.value < 0).sort((a, b) => a.value - b.value || a.points - b.points)[0];
    perTeam[id] = { steal: st ? st.overall : null, bust: bu ? bu.overall : null };
  }

  return {
    year, available: true, auction, complete: Number(year) < Number(SEASON), statsAvailable: rows.filter((r) => r.points != null).length >= rows.length * 0.5,
    namesFound, namesTotal: ids.length, scoring: HALF_PPR_NOTE, rankScope: hp.poolOk && hp.pool.length ? "all" : "drafted",
    perTeam,
    rounds: Math.max(...rows.map((r) => r.round || 0)), teams, picks: rows,
    steals: steals.map((r) => r.overall), busts: busts.map((r) => r.overall),
  };
}

export default async (req) => {
  const year = Number(new URL(req.url).searchParams.get("season") || SEASON);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return json(400, { error: "Invalid season." });
  const store = getStore({ name: "cache", consistency: "strong" });
  const key = `hist/draft/v3/${year}`;
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
