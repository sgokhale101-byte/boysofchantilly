// Power rankings from the league message board, served at /api/power.
// Looks for posts by the member named in POWER_AUTHOR (default "Saffa") that mention power rankings.
import { BASE, SEASON, LEAGUE_ID, EspnError, espnFetch, leagueUrl } from "../lib/espn.mjs";

const json = (status, obj, cache = "no-store") => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json", "cache-control": cache },
});
const AUTHOR = (process.env.POWER_AUTHOR || "Saffa").toLowerCase();

function plain(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n").replace(/<li[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
function memberName(m) {
  const full = `${m.firstName || ""} ${m.lastName || ""}`.trim();
  return [full, m.displayName].filter(Boolean).join(" ");
}

// "1. Team name - blurb" style lines become a ranked list.
function parseRanks(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^\s*#?\s*(\d{1,2})\s*[\.\):\-–]\s*(.+)$/.exec(line);
    if (!m) { if (out.length && line.trim()) out[out.length - 1].blurb += (out[out.length - 1].blurb ? " " : "") + line.trim(); continue; }
    const rest = m[2].trim();
    const split = /^(.+?)\s*:\s+(.+)$/.exec(rest) || /^(.+?)\s+[-–—]\s+(.+)$/.exec(rest);
    out.push({ rank: Number(m[1]), title: (split ? split[1] : rest).trim(), blurb: split ? split[2].trim() : "" });
  }
  return out.length >= 3 ? out : null;
}

export default async () => {
  let league, topics;
  try {
    league = JSON.parse(await espnFetch(leagueUrl(["mTeam"])));
    const url = `${BASE}/${SEASON}/segments/0/leagues/${LEAGUE_ID}/communication/?view=kona_league_communication`;
    const filter = { topics: { limit: 100, sortMessageDate: { sortPriority: 1, sortAsc: false } } };
    const data = JSON.parse(await espnFetch(url, { "X-Fantasy-Filter": JSON.stringify(filter) }));
    topics = data.topics || [];
  } catch (e) {
    return json(e instanceof EspnError ? e.status : 500, { error: e.message || "Couldn't read the message board." });
  }

  const members = {};
  (league.members || []).forEach((m) => (members[m.id] = memberName(m)));
  const authorIds = new Set(Object.entries(members).filter(([, n]) => n.toLowerCase().includes(AUTHOR)).map(([id]) => id));

  const posts = topics
    .filter((t) => !String(t.type || "").toUpperCase().startsWith("ACTIVITY"))
    .map((t) => {
      const msgs = t.messages || [];
      return {
        id: t.id, type: t.type || "", date: t.date || msgs[0]?.date || 0,
        authorId: t.author || msgs[0]?.author || null,
        title: plain(t.title || ""),
        text: plain(msgs.map((m) => m.content).filter(Boolean).join("\n\n") || t.content || ""),
      };
    })
    .filter((p) => p.text || p.title);

  const byAuthor = authorIds.size ? posts.filter((p) => authorIds.has(p.authorId)) : [];
  let power = byAuthor.filter((p) => /power/i.test(`${p.title} ${p.text}`));
  if (!power.length) power = byAuthor.length ? byAuthor : posts.filter((p) => /power\s*rank/i.test(`${p.title} ${p.text}`));

  const out = power.sort((a, b) => b.date - a.date).map((p) => ({
    id: p.id, date: p.date, title: p.title, author: members[p.authorId] || "", text: p.text, ranks: parseRanks(p.text),
  }));
  const diagnostic = out.length ? null : {
    topicsReturned: topics.length,
    postTypes: [...new Set(topics.map((t) => t.type || "unknown"))],
    authorMatched: [...authorIds].map((id) => members[id]),
    authorsSeen: [...new Set(posts.map((p) => members[p.authorId] || p.authorId || "unknown"))].slice(0, 12),
  };
  return json(200, { posts: out, diagnostic }, "public, max-age=300");
};

export const config = { path: "/api/power" };
