// Draft recap for any season, served at /api/draft?season=YYYY.
// Steals and busts compare where a player was drafted among his position with where he finished
// among drafted players at his position (kickers and defenses left out).
import { getStore } from "@netlify/blobs";
import { SEASON, EspnError, seasonLeague } from "../lib/espn.mjs";
import { POS } from "../lib/model.mjs";

const json = (status, obj, cache = "no-store") => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": cache },
});
const r2 = (n) => Math.round((n || 0) * 100) / 100;
const SKIP = new Set(["K", "D/ST"]);

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

  // Player names and season points, 50 at a time.
  const ids = [...new Set(picks.map((p) => p.playerId))];
  const info = {};
  let statsOk = true;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const filter = { players: { filterIds: { value: chunk }, limit: chunk.length } };
    try {
      const data = await seasonLeague(year, ["kona_player_info"], null, { "X-Fantasy-Filter": JSON.stringify(filter) });
      for (const x of data.players || []) {
        const p = x.player || x;
        info[p.id] = { name: p.fullName, pos: POS[p.defaultPositionId] || "", points: seasonPoints(p, year) };
      }
    } catch { statsOk = false; }
  }

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
    rounds: Math.max(...rows.map((r) => r.round || 0)), teams, picks: rows,
    steals: steals.map((r) => r.overall), busts: busts.map((r) => r.overall),
  };
}

export default async (req) => {
  const year = Number(new URL(req.url).searchParams.get("season") || SEASON);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return json(400, { error: "Invalid season." });
  const store = getStore({ name: "cache", consistency: "strong" });
  const key = `hist/draft/v1/${year}`;
  try {
    if (year < Number(SEASON)) {
      const hit = await store.get(key, { type: "json" }).catch(() => null);
      if (hit) return json(200, hit, "public, max-age=3600");
    }
    const d = await buildDraft(year);
    if (d.available && d.complete && d.statsAvailable) await store.setJSON(key, d).catch(() => {});
    return json(200, d, d.complete ? "public, max-age=3600" : "public, max-age=900");
  } catch (e) {
    return json(e instanceof EspnError ? e.status : 500, { error: e.message || "Couldn't load the draft." });
  }
};

export const config = { path: "/api/draft" };
