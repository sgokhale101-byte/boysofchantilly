// Half-PPR season points computed from raw NFL stats, so every season uses the same scoring.
import { BASE, espnFetch } from "./espn.mjs";
import { POS } from "./model.mjs";

// ESPN fantasy stat ids -> half-PPR points per unit
const WEIGHTS = {
  3: 0.04,   // passing yards
  4: 4,      // passing TDs
  20: -2,    // interceptions thrown
  19: 2,     // passing 2-pt conversions
  24: 0.1,   // rushing yards
  25: 6,     // rushing TDs
  26: 2,     // rushing 2-pt conversions
  42: 0.1,   // receiving yards
  43: 6,     // receiving TDs
  44: 2,     // receiving 2-pt conversions
  53: 0.5,   // receptions
  72: -2,    // fumbles lost
};
const r2 = (n) => Math.round(n * 100) / 100;
export const HALF_PPR_NOTE = "Half-PPR: 0.04 per passing yard, 4 per passing TD, -2 per interception, 0.1 per rushing or receiving yard, 6 per rushing or receiving TD, 0.5 per catch, -2 per fumble lost, 2 per two-point conversion.";

export function halfPprFromRaw(stats) {
  if (!stats) return null;
  let pts = 0, any = false;
  for (const [id, w] of Object.entries(WEIGHTS)) {
    const v = Number(stats[id]);
    if (Number.isFinite(v)) { pts += v * w; any = true; }
  }
  return any ? r2(pts) : null;
}

// Season totals (actual, full season) from an ESPN fantasy player object.
export function seasonRaw(p, year) {
  for (const s of p.stats || []) {
    if (s.statSourceId !== 0 || s.scoringPeriodId !== 0) continue;
    if (s.statSplitTypeId != null && s.statSplitTypeId !== 0) continue;
    if (s.seasonId != null && Number(s.seasonId) !== Number(year)) continue;
    if (s.stats && Object.keys(s.stats).length) return s.stats;
  }
  return null;
}

function playersOf(j) {
  const list = Array.isArray(j) ? j : j?.players || [];
  return list.map((x) => x.player || x).filter((p) => p && p.id != null);
}

// ESPN's public fantasy player data for a season (no league needed).
async function publicPlayers(year, filter) {
  const url = `${BASE}/${year}/players?scoringPeriodId=0&view=kona_player_info`;
  return playersOf(JSON.parse(await espnFetch(url, { "X-Fantasy-Filter": JSON.stringify(filter) })));
}

// Backup: ESPN's public NFL stats page for one player and season.
const STAT_NAMES = {
  passingYards: 0.04, passingTouchdowns: 4, interceptions: -2,
  rushingYards: 0.1, rushingTouchdowns: 6,
  receptions: 0.5, receivingYards: 0.1, receivingTouchdowns: 6,
  fumblesLost: -2,
};
async function athleteSeason(id, year) {
  try {
    const r = await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}/stats?season=${year}&seasontype=2`, { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    let pts = 0, any = false; const seen = new Set();
    for (const cat of j.categories || []) {
      const names = cat.names || [];
      const row = (cat.statistics || []).find((x) => Number(x.season?.year) === Number(year)) || null;
      if (!row) continue;
      names.forEach((n, i) => {
        if (!(n in STAT_NAMES) || seen.has(n)) return;
        const v = Number(String(row.stats?.[i] ?? "").replace(/,/g, ""));
        if (Number.isFinite(v)) { pts += v * STAT_NAMES[n]; any = true; seen.add(n); }
      });
    }
    return any ? r2(pts) : null;
  } catch { return null; }
}

// Half-PPR points and position for a set of player ids, plus the season's top players at each
// skill position (so finishes rank against everyone, drafted or not).
export async function seasonHalfPpr(year, ids) {
  const out = {}; // id -> { name, pos, points }
  const take = (p) => {
    const pts = halfPprFromRaw(seasonRaw(p, year));
    const prev = out[p.id] || {};
    out[p.id] = { name: prev.name || p.fullName || null, pos: prev.pos || POS[p.defaultPositionId] || "", points: pts ?? prev.points ?? null };
  };
  let publicOk = true;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try { (await publicPlayers(year, { players: { filterIds: { value: chunk }, limit: chunk.length } })).forEach(take); }
    catch { publicOk = false; }
  }
  // The season's leaders at each position.
  const pool = new Set();
  let poolOk = true;
  await Promise.all([0, 2, 4, 6].map(async (slot) => {
    try {
      const list = await publicPlayers(year, { players: {
        filterSlotIds: { value: [slot] }, limit: 80,
        sortAppliedStatTotal: { sortAsc: false, sortPriority: 1, value: `00${year}` },
      } });
      list.forEach((p) => { take(p); pool.add(p.id); });
    } catch { poolOk = false; }
  }));
  // Backup for drafted players still missing points.
  const missing = ids.filter((id) => id > 0 && out[id]?.points == null);
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const pts = await Promise.all(chunk.map((id) => athleteSeason(id, year)));
    chunk.forEach((id, k) => { if (pts[k] != null) out[id] = { ...(out[id] || { name: null, pos: "" }), points: pts[k] }; });
  }
  return { players: out, pool: [...pool], poolOk, publicOk };
}
