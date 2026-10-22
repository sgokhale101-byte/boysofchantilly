// Power rankings from the league message board, served at /api/power.
// Looks for posts by the member named in POWER_AUTHOR (default "Saffa") that mention power rankings.
import { getStore } from "@netlify/blobs";
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
    // The board mixes posts with every add/drop/trade notice, so page back through all of it.
    const url = `${BASE}/${SEASON}/segments/0/leagues/${LEAGUE_ID}/communication/?view=kona_league_communication`;
    topics = [];
    const seen = new Set();
    for (let page = 0; page < 15; page++) {
      const filter = { topics: { limit: 100, offset: page * 100, sortMessageDate: { sortPriority: 1, sortAsc: false } } };
      const data = JSON.parse(await espnFetch(url, { "X-Fantasy-Filter": JSON.stringify(filter) }));
      const batch = (data.topics || []).filter((t) => !seen.has(t.id));
      batch.forEach((t) => seen.add(t.id));
      topics.push(...batch);
      if ((data.topics || []).length < 100 || !batch.length) break;
    }
  } catch (e) {
    return json(e instanceof EspnError ? e.status : 500, { error: e.message || "Couldn't read the message board." });
  }

  const members = {};
  (league.members || []).forEach((m) => (members[m.id] = memberName(m)));
  const authorIds = new Set(Object.entries(members).filter(([, n]) => n.toLowerCase().includes(AUTHOR)).map(([id]) => id));

  // Every edition: a thread's first post and each of Saffa's replies count separately.
  const editions = [];
  for (const t of topics) {
    if (String(t.type || "").toUpperCase().startsWith("ACTIVITY")) continue;
    const msgs = t.messages?.length ? t.messages : [{ content: t.content, author: t.author, date: t.date }];
    msgs.forEach((m, i) => {
      const authorId = m.author || t.author || null;
      const text = plain(m.content || "");
      if (!text) return;
      // A reply is named by its opening line ("Week 3:") when it has one.
      const first = text.split("\n")[0].trim();
      const heading = !/^#?\s*\d+\s*[.):\-]/.test(first) && first.length <= 40 ? first.replace(/[:\-–]\s*$/, "") : "";
      const title = i === 0 ? (plain(t.title || "") || heading) : heading || `${plain(t.title || "Power Rankings")} (update)`;
      const header = [t.title, t.subject, t.name, m.title, m.subject, ...text.split("\n").slice(0, 3)].filter(Boolean).map((x) => plain(String(x))).join("\n");
      editions.push({ id: `${t.id}:${m.id ?? i}`, topicId: t.id, date: m.date || t.date || 0, authorId, title, text, header, topLevel: i === 0, fields: Object.keys(t).join(",") });
    });
  }
  // An edition is a post titled like "Power Rankings after Week N" (title, or the opening line of a reply).
  // An edition is a "power rankings" post; its week comes from "Week N" / "Wk N" anywhere in the title or opening lines.
  const head = (e) => `${e.title}\n${e.text.split("\n").slice(0, 2).join("\n")}`;
  const isPower = (e) => /power\s*-?\s*rank/i.test(head(e)) || /power\s*-?\s*rank/i.test(e.title);
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18 };
  const weekOf = (e) => {
    const m = /\b(?:week|wk)\.?\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen)\b/i.exec(head(e));
    return m ? (Number(m[1]) || WORDS[m[1].toLowerCase()] || null) : null;
  };
  // An edition: a top-level post whose title says "power rankings" and names a week (digits or words).
  // The "title" can live in several places, so check the title/subject fields and the post's opening lines.
  const hdr = (e) => e.header || `${e.title || ""}\n${(e.text || "").split("\n").slice(0, 3).join("\n")}`;
  const titleWeek = (e) => { const m = /\b(?:week|wk)\.?\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen)\b/i.exec(hdr(e)); return m ? (Number(m[1]) || WORDS[m[1].toLowerCase()] || null) : null; };
  const strict = (e) => e.topLevel !== false && /power\s*-?\s*rank/i.test(hdr(e)) && titleWeek(e) != null;
  // Fallback when nothing passes: Saffa's top-level posts that say "power rankings" early on and contain a numbered ranking.
  const loose = (e) => e.topLevel !== false && authorIds.has(e.authorId) && /power\s*-?\s*rank/i.test((e.text || "").slice(0, 400) + hdr(e)) && Boolean(parseRanks(e.text || ""));
  const looksLikeRankings = (e) => strict(e);
  // Saffa's ranking posts, plus any post titled "power rankings" (in case one came from a different account)
  let found = editions.filter(strict);
  const usedLoose = !found.length;
  if (usedLoose) found = editions.filter(loose);

  // Keep a copy of every edition ever seen, so an edited or deleted post stays readable.
  const store = getStore({ name: "cache", consistency: "strong" });
  const key = `power/archive/v3/${SEASON}`;
  let archive = {};
  try { archive = (await store.get(key, { type: "json" })) || {}; } catch {}
  let changed = false;
  const hash = (t) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  for (const e of found) {
    const k = `${e.id}:${hash(e.text)}`;
    if (!archive[k]) { archive[k] = { ...e, seenAt: Date.now() }; changed = true; }
  }
  if (changed) { try { await store.setJSON(key, archive); } catch {} }
  const all = Object.entries(archive).map(([k, e]) => ({ ...e, key: k }));
  // If one post was edited over time, label the older copies as earlier versions.
  const byPost = {};
  all.forEach((e) => (byPost[e.id] ||= []).push(e));


  // One edition per week: the latest saved version of that week's post. Archived entries are re-checked too.
  // Posts with no readable week number are numbered by date after the ones that have one.
  const ok = all.filter((e) => strict(e) || (usedLoose && loose(e)));
  const perWeek = {};
  const noWeek = ok.filter((e) => titleWeek(e) == null).sort((a, b) => (a.date || a.seenAt) - (b.date || b.seenAt));
  const taken = new Set(ok.map(titleWeek).filter((w) => w != null));
  let n = 1; const dateWeek = new Map();
  for (const e of noWeek) { if (dateWeek.has(e.id)) continue; while (taken.has(n)) n++; dateWeek.set(e.id, n); taken.add(n); }
  for (const e of ok) {
    const wk = titleWeek(e) ?? dateWeek.get(e.id); if (wk == null) continue;
    const cur = perWeek[wk];
    if (!cur || (e.seenAt || 0) > (cur.seenAt || 0) || ((e.seenAt || 0) === (cur.seenAt || 0) && (e.date || 0) > (cur.date || 0))) perWeek[wk] = e;
  }
  const out = Object.entries(perWeek).sort((a, b) => Number(b[0]) - Number(a[0])).map(([wk, p]) => ({
    id: p.key, week: Number(wk), date: p.date || p.seenAt, title: `Power Rankings after Week ${wk}`, author: members[p.authorId] || "", text: p.text, ranks: parseRanks(p.text),
  }));
  const posts = editions;
  const diagnostic = out.length ? null : {
    topicsReturned: topics.length,
    postTypes: [...new Set(topics.map((t) => t.type || "unknown"))],
    authorMatched: [...authorIds].map((id) => members[id]),
    authorsSeen: [...new Set(posts.map((p) => members[p.authorId] || p.authorId || "unknown"))].slice(0, 12),
    editionsSeen: posts.length,
    authorTitles: posts.filter((p) => authorIds.has(p.authorId) && p.topLevel).slice(0, 8).map((p) => p.header.replace(/\n/g, " / ").slice(0, 120)),
    topicFields: posts[0]?.fields || "",
  };
  return json(200, { posts: out, diagnostic }, "public, max-age=60");
};

export const config = { path: "/api/power" };
