// The auditor: deterministic checks on a drafted answer before it is accepted.
// A draft that fails is sent back to the model once with the findings; if the
// final answer still fails, the audit is marked needs_review and the app shows it.

export const stripRefs = (text) => text.replace(/\s?\[\d+(?:\s*,\s*\d+)*\]/g, "");

export const citedRefs = (text) => [
  ...new Set([...text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(/\s*,\s*/).map(Number))),
];

const normalise = (n) => n.replace(/,/g, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

/** Figures that must come from evidence: numbers of 3+ digits and every percentage, normalised ("1,165,971" -> "1165971"). */
export const figures = (text) => {
  const plain = stripRefs(text);
  const big = (plain.match(/\d[\d,]*(?:\.\d+)?/g) || []).map(normalise).filter((n) => n.replace(".", "").length >= 3);
  const percents = [...plain.matchAll(/(\d+(?:\.\d+)?)\s?(?:%|percent|per cent)/gi)].map((m) => normalise(m[1]));
  return [...new Set([...big, ...percents])];
};

/** Normalises text for figure lookups: thousands separators removed. */
export const toEvidence = (text) => String(text).replace(/(\d),(?=\d{3})/g, "$1");

// A figure is traced when it appears in the evidence as a whole number ("25" is not found inside "1250").
// Figures are normalised without trailing zeros ("9403.30" → "9403.3"), so a decimal one also
// matches the evidence written with them (an HS code in a tool result).
const traced = (n, evidence) => new RegExp(`(^|[^\\d.])${n.replace(".", "\\.")}${n.includes(".") ? "0*" : ""}(?![\\d])`).test(evidence);

const URL_RE = /https?:\/\/[^\s)\]>"'`]+/g;
const trimUrl = (u) => u.replace(/[.,;:!?]+$/, "").replace(/\/$/, "");

/** Links in the answer that are not the url of a retrieved source (an injected link would be one). */
export function strayLinks(answer, retrieved) {
  const known = retrieved.filter((r) => typeof r.url === "string" && r.url.startsWith("http")).map((r) => trimUrl(r.url));
  return [...new Set((answer.match(URL_RE) || []).map(trimUrl))].filter((u) => !known.some((k) => u === k || u.startsWith(`${k}/`)));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Whether the answer gives this date in a common form: 2026-10-05, 5 Oct, October 5th, 5/10, 10/5 or "5 tháng 10". */
export function mentionsDate(answer, iso) {
  const d = new Date(iso);
  if (isNaN(d)) return true;
  const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  const month = `(?:${MONTHS[m - 1]}|${MONTHS[m - 1].slice(0, 3)})\\.?`;
  const dd = `0?${day}(?:st|nd|rd|th)?`;
  return [
    `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    `(^|[^\\d])${dd}\\s+(?:of\\s+)?${month}`,
    `${month}\\s+${dd}(?![\\d])`,
    `(^|[^\\d])0?${day}/0?${m}(?![\\d])`,
    `(^|[^\\d])0?${m}/0?${day}(?![\\d])`,
    `(^|[^\\d])${day}\\s+tháng\\s+${m}(?![\\d])`,
  ].some((p) => new RegExp(p, "i").test(answer));
}

/** Cited news (articles and alerts) whose publication date the answer doesn't give. */
export const undatedNews = (answer, citations) =>
  citations.filter((c) => ["article", "alert"].includes(c.type) && c.publishedAt && !mentionsDate(answer, c.publishedAt));

/** Orders a knowledge graph walk reached (query_graph's path citations) that the answer names without citing a path to them. */
export function uncitedPaths(answer, retrieved, cited) {
  const paths = retrieved.filter((r) => r.type === "path");
  const plain = stripRefs(answer);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = [...new Set(paths.map((p) => p.id))].filter((id) => new RegExp(`(^|[^A-Za-z0-9-])${escape(id)}(?![A-Za-z0-9-])`).test(plain));
  return named.filter((id) => !paths.some((p) => p.id === id && cited.includes(p.ref)));
}

/** Auditor checks on an answer: citations resolve, figures come from evidence, tool use is cited, news is dated, links are sources, graph connections cite their paths. */
export function review({ answer, retrieved, evidence, usedTools }) {
  const cited = citedRefs(answer);
  const citations = cited.map((n) => retrieved.find((r) => r.ref === n)).filter(Boolean);
  const invalid = cited.filter((n) => !retrieved.some((r) => r.ref === n));
  const checked = figures(answer);
  const untraced = usedTools ? checked.filter((n) => !traced(n, evidence)) : [];
  const links = strayLinks(answer, retrieved);
  // Like a reviewer that rejects a rule cited without its version and date: news is only
  // evidence together with when it was published.
  const undated = undatedNews(answer, citations);
  // Like a citation for a figure: an order said to be connected cites the path that connects it.
  const pathless = uncitedPaths(answer, retrieved, cited);
  const checks = [
    {
      name: "Citations point to retrieved evidence",
      ok: invalid.length === 0,
      detail: invalid.length ? `Unknown refs: ${invalid.join(", ")}` : `${citations.length} of ${retrieved.length} retrieved sources cited`,
    },
    {
      name: "Figures traceable to tool results",
      ok: untraced.length === 0,
      detail: !usedTools ? "No tools used" : untraced.length ? `Not found in tool results: ${untraced.join(", ")}` : `${checked.length} figures checked`,
    },
    {
      name: "Answer grounded in tool results",
      ok: !usedTools || citations.length > 0,
      detail: usedTools ? (citations.length ? "Cites tool results" : "Tools were used but nothing is cited") : "No tools needed (general knowledge)",
    },
    {
      name: "News cited with its date",
      ok: undated.length === 0,
      detail: undated.length ? `No date given for ${undated.map((c) => `[${c.ref}]`).join(", ")}` : "Every cited article and alert is dated",
    },
    {
      name: "Links come from retrieved sources",
      ok: links.length === 0,
      detail: links.length ? `Not a retrieved source: ${links.join(", ")}` : "No outside links",
    },
    {
      name: "Connections cite their graph paths",
      ok: pathless.length === 0,
      detail: pathless.length ? `No path cited for ${pathless.join(", ")}` : retrieved.some((r) => r.type === "path") ? "Every order named from the graph cites its path" : "No graph paths retrieved",
    },
  ];
  const problems = [];
  if (invalid.length) problems.push(`Citations [${invalid.join("], [")}] do not match any tool result.`);
  if (untraced.length) problems.push(`These figures do not appear in any tool result: ${untraced.join(", ")}.`);
  if (usedTools && !citations.length) problems.push("The draft cites nothing; cite the tool results you used.");
  if (undated.length)
    problems.push(`Say when the news you cite was published: ${undated.map((c) => `[${c.ref}] ${c.publishedAt.slice(0, 10)}`).join(", ")}.`);
  if (links.length) problems.push(`These links are not the url of any retrieved source: ${links.join(", ")}. Remove them.`);
  if (pathless.length)
    problems.push(`Cite the knowledge graph path (its ref from query_graph) for each order you name as connected: ${pathless.join(", ")}.`);
  return { checks, citations, problems };
}
