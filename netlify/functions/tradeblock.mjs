// Trading block, served at /api/tradeblock: players teams have put on the block,
// and other teams' players they've marked as interested.
import { EspnError, espnFetch, leagueUrl } from "../lib/espn.mjs";
import { POS } from "../lib/model.mjs";

const json = (status, obj, cache = "no-store") => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": cache },
});

// ESPN may store the block as { playerId: status } or as a list; accept either.
function blockEntries(tb) {
  if (!tb) return [];
  const src = tb.players ?? tb;
  if (Array.isArray(src)) return src.map((x) => [x.playerId ?? x.id, x.type ?? x.status ?? ""]).filter(([id]) => id != null);
  if (typeof src === "object") return Object.entries(src);
  return [];
}

export default async () => {
  let L;
  try { L = JSON.parse(await espnFetch(leagueUrl(["mTeam", "mRoster"]))); }
  catch (e) { return json(e instanceof EspnError ? e.status : 500, { error: e.message }); }

  const roster = {};
  for (const t of L.teams || []) for (const e of t.roster?.entries || []) {
    const p = e.playerPoolEntry?.player || {};
    roster[e.playerId] = { teamId: t.id, name: p.fullName || `Player ${e.playerId}`, pos: POS[p.defaultPositionId] || "" };
  }
  const fieldSeen = (L.teams || []).some((t) => "tradeBlock" in t);
  const available = [], interested = [];
  for (const t of L.teams || []) {
    for (const [pid, status] of blockEntries(t.tradeBlock)) {
      const id = Number(pid), info = roster[id];
      const entry = { teamId: t.id, playerId: id, status: String(status), player: info ? { name: info.name, pos: info.pos } : { name: `Player ${id}`, pos: "" }, ownerTeamId: info?.teamId ?? null };
      (info && info.teamId === t.id ? available : interested).push(entry);
    }
  }
  return json(200, { fieldSeen, available, interested }, "public, max-age=120");
};

export const config = { path: "/api/tradeblock" };
