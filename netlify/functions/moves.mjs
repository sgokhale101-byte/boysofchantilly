// Completed waivers, free-agent moves, and trades for a week, with player names resolved
// and each team's FAAB left after every move. Served at /api/moves?week=N.
import { EspnError, espnFetch, leagueUrl } from "../lib/espn.mjs";
import { seasonMoves, playerNames } from "../lib/tx.mjs";

const json = (status, obj, cache = "no-store") => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": cache },
});

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
  const names = await playerNames(ids);

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
