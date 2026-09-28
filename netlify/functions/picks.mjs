// Pick 'em votes, served at /api/picks. Stored in Netlify Blobs.
//   GET  /api/picks?week=3&voter=<id>  -> tallies for the week + this voter's picks
//   POST /api/picks {week, matchupId, choice: "home"|"away", voter}
// One vote per phone (voter id) and one per person (the "I'm" pick, when set) on each matchup.
// Voting closes for the whole week once the week's first NFL game kicks off.
import { getStore } from "@netlify/blobs";
import { EspnError, espnFetch, leagueUrl, sidePoints } from "../lib/espn.mjs";
import { nflWeek } from "../lib/model.mjs";

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const VOTER_RE = /^[A-Za-z0-9-]{16,64}$/;
const store = () => getStore({ name: "pickem", consistency: "strong" });

async function tallies(s, week) {
  const { blobs } = await s.list({ prefix: `tally/w${week}/` });
  const out = {};
  for (const b of blobs) {
    // key: tally/w{week}/m{id}/{choice}/{voter}
    const [, , m, choice] = b.key.split("/");
    const id = m.slice(1);
    out[id] ||= { home: 0, away: 0 };
    if (choice === "home" || choice === "away") out[id][choice]++;
  }
  return out;
}

async function mine(s, week, voter) {
  if (!voter || !VOTER_RE.test(voter)) return {};
  const { blobs } = await s.list({ prefix: `voter/${voter}/w${week}/` });
  const out = {};
  await Promise.all(blobs.map(async (b) => {
    const id = b.key.split("/").pop().slice(1);
    out[id] = await s.get(b.key);
  }));
  return out;
}

export default async (req) => {
  const s = store();
  const url = new URL(req.url);

  if (req.method === "GET") {
    const week = Number(url.searchParams.get("week"));
    if (!Number.isInteger(week) || week < 1 || week > 30) return json(400, { error: "Invalid week." });
    const voter = url.searchParams.get("voter");
    const [t, m] = await Promise.all([tallies(s, week), mine(s, week, voter)]);
    return json(200, { week, tallies: t, mine: m });
  }

  if (req.method !== "POST") return json(405, { error: "Method not allowed." });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Invalid request." }); }
  const week = Number(body.week), matchupId = Number(body.matchupId);
  const { choice, voter } = body;
  if (!Number.isInteger(week) || !Number.isInteger(matchupId)) return json(400, { error: "Invalid matchup." });
  if (choice !== "home" && choice !== "away") return json(400, { error: "Pick a team." });
  if (!VOTER_RE.test(voter || "")) return json(400, { error: "Missing voter id. Reload the page and try again." });

  // Check the matchup against ESPN: must be this week's and not started yet.
  let league;
  try {
    league = JSON.parse(await espnFetch(leagueUrl(["mStatus", "mScoreboard"], week)));
  } catch (e) {
    return json(e instanceof EspnError ? e.status : 502, { error: e.message || "Couldn't verify the matchup." });
  }
  const current = league.status?.currentMatchupPeriod;
  if (week !== current) return json(409, { error: "Voting is only open for the current week." });
  const game = (league.schedule || []).find((g) => g.id === matchupId && g.matchupPeriodId === week);
  if (!game || !game.away) return json(404, { error: "That matchup isn't on this week's schedule." });
  const weekGames = (league.schedule || []).filter((g) => g.matchupPeriodId === week);
  const nfl = await nflWeek(week);
  const kicked = Object.values(nfl.byTeam).some((g) => g.state !== "pre") || weekGames.some((g) => sidePoints(g.home) > 0 || sidePoints(g.away) > 0);
  if (kicked) return json(409, { error: "Voting closed when the week's first game kicked off." });

  const voterKey = `voter/${voter}/w${week}/m${matchupId}`;
  if (await s.get(voterKey)) return json(409, { error: "This phone already voted on this matchup." });
  const person = Number(body.person);
  const personKey = Number.isInteger(person) && person > 0 ? `person/w${week}/m${matchupId}/${person}` : null;
  if (personKey && (await s.get(personKey))) return json(409, { error: "Someone already voted as you on this matchup." });
  await s.set(voterKey, choice);
  if (personKey) await s.set(personKey, "1");
  await s.set(`tally/w${week}/m${matchupId}/${choice}/${voter}`, "1");

  const t = await tallies(s, week);
  return json(200, { ok: true, choice, tally: t[matchupId] || { home: 0, away: 0 } });
};

export const config = { path: "/api/picks" };
