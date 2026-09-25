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
    info[id] = { name: info[id]?.name || h?.name || null, pos: info[id]?.pos || h?.pos || "", points: h?.points ?? null, gp: h?.gp ?? null, adp: h?.adp ?? null };
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
    points: info[p.playerId]?.points ?? null, gp: info[p.playerId]?.gp ?? null, adp: info[p.playerId]?.adp ?? null,
  })).sort((a, b) => a.overall - b.overall);

  const complete = Number(year) < Number(SEASON);
  const MIN_GAMES = 6; // PPG rank needs a real sample
  // Starter tiers and "big move" thresholds by position.
  const TIER = { QB: 12, TE: 12, RB: 24, WR: 30 };
  const JUMP = { QB: 6, TE: 6, RB: 12, WR: 15 };

  // Positional ranks:
  //   posDraftRank  order taken in this league at the position (price, for auctions)
  //   posAdpRank    ESPN average draft position at the position (league order if ADP is missing)
  //   posFinishRank total half-PPR points
  //   posPpgRank    half-PPR points per game (min 6 games)
  // Rankings run against every player at the position we have (drafted plus the season's top 80).
  const byPos = {};
  rows.forEach((r) => (byPos[r.pos] ||= []).push(r));
  const universe = {};
  for (const [id, h] of Object.entries(hp.players)) if (h.points != null && h.pos) (universe[h.pos] ||= new Map()).set(Number(id), h);
  const adpCoverage = rows.filter((r) => r.adp != null).length / Math.max(1, rows.length);
  const useAdp = adpCoverage >= 0.5;
  for (const [pos, list] of Object.entries(byPos)) {
    [...list].sort((a, b) => auction ? b.bid - a.bid || a.overall - b.overall : a.overall - b.overall).forEach((r, i) => (r.posDraftRank = i + 1));
    [...list].sort((a, b) => useAdp ? (a.adp ?? 999) - (b.adp ?? 999) || a.overall - b.overall : a.posDraftRank - b.posDraftRank).forEach((r, i) => (r.posAdpRank = i + 1));
    const pool = new Map(universe[pos] || []);
    list.forEach((r) => { if (r.points != null) pool.set(r.playerId, { points: r.points, gp: r.gp }); });
    const byTotal = [...pool.entries()].sort((a, b) => b[1].points - a[1].points).map(([id]) => id);
    const byPpg = [...pool.entries()].filter(([, h]) => h.gp >= MIN_GAMES).sort((a, b) => b[1].points / b[1].gp - a[1].points / a[1].gp).map(([id]) => id);
    list.forEach((r) => {
      const i = byTotal.indexOf(r.playerId), j = byPpg.indexOf(r.playerId);
      r.posFinishRank = r.points == null || i < 0 ? null : i + 1;
      r.posPpgRank = j < 0 ? null : j + 1;
      r.ppg = r.points != null && r.gp ? Math.round((r.points / r.gp) * 100) / 100 : null;
      // The yardstick: PPG rank for finished seasons, total points rank for the current one.
      r.metric = complete ? r.posPpgRank : r.posFinishRank;
    });
  }

  // Tags on the draft board, against where the player went in this league.
  for (const r of rows) {
    if (SKIP.has(r.pos) || !TIER[r.pos]) continue;
    const early = r.posDraftRank <= TIER[r.pos];
    if (r.metric != null && r.metric <= TIER[r.pos] && r.posDraftRank - r.metric >= JUMP[r.pos]) r.tag = "steal";
    else if (early && r.metric != null && r.metric - r.posDraftRank >= JUMP[r.pos]) r.tag = "bust";
    else if (complete && early && r.posDraftRank <= TIER[r.pos] / 2 && r.gp != null && r.gp < MIN_GAMES) { r.tag = "bust"; r.tagNote = "missed most of the season"; }
  }

  // Top 5 steals and busts against ADP. Keepers are left out of finished seasons.
  const boxable = rows.filter((r) => TIER[r.pos] && r.metric != null && !(complete && r.keeper));
  const vsAdp = (r) => r.posAdpRank - r.metric;
  const steals = boxable.filter((r) => vsAdp(r) >= 3 && r.metric <= TIER[r.pos]).sort((a, b) => vsAdp(b) - vsAdp(a) || a.metric - b.metric).slice(0, 5);
  const busts = boxable.filter((r) => vsAdp(r) <= -3 && r.posAdpRank <= TIER[r.pos]).sort((a, b) => vsAdp(a) - vsAdp(b) || a.posAdpRank - b.posAdpRank).slice(0, 5);

  return {
    year, available: true, auction, complete, statsAvailable: rows.filter((r) => r.points != null).length >= rows.length * 0.5,
    namesFound, namesTotal: ids.length, scoring: HALF_PPR_NOTE, rankScope: hp.poolOk && hp.pool.length ? "all" : "drafted",
    adpSource: useAdp ? "espn" : "league", minGames: MIN_GAMES,
    rounds: Math.max(...rows.map((r) => r.round || 0)), teams, picks: rows,
    steals: steals.map((r) => r.overall), busts: busts.map((r) => r.overall),
  };
}

export default async (req) => {
  const year = Number(new URL(req.url).searchParams.get("season") || SEASON);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return json(400, { error: "Invalid season." });
  const store = getStore({ name: "cache", consistency: "strong" });
  const key = `hist/draft/v4/${year}`;
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
