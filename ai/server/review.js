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
const traced = (n, evidence) => new RegExp(`(^|[^\\d.])${n.replace(".", "\\.")}(?![\\d])`).test(evidence);

const URL_RE = /https?:\/\/[^\s)\]>"'`]+/g;
const trimUrl = (u) => u.replace(/[.,;:!?]+$/, "").replace(/\/$/, "");

/** Links in the answer that are not the url of a retrieved source (an injected link would be one). */
export function strayLinks(answer, retrieved) {
  const known = retrieved.filter((r) => typeof r.url === "string" && r.url.startsWith("http")).map((r) => trimUrl(r.url));
  return [...new Set((answer.match(URL_RE) || []).map(trimUrl))].filter((u) => !known.some((k) => u === k || u.startsWith(`${k}/`)));
}

/** Auditor checks on an answer: citations resolve, figures come from evidence, tool use is cited, links are sources. */
export function review({ answer, retrieved, evidence, usedTools }) {
  const cited = citedRefs(answer);
  const citations = cited.map((n) => retrieved.find((r) => r.ref === n)).filter(Boolean);
  const invalid = cited.filter((n) => !retrieved.some((r) => r.ref === n));
  const checked = figures(answer);
  const untraced = usedTools ? checked.filter((n) => !traced(n, evidence)) : [];
  const links = strayLinks(answer, retrieved);
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
      name: "Links come from retrieved sources",
      ok: links.length === 0,
      detail: links.length ? `Not a retrieved source: ${links.join(", ")}` : "No outside links",
    },
  ];
  const problems = [];
  if (invalid.length) problems.push(`Citations [${invalid.join("], [")}] do not match any tool result.`);
  if (untraced.length) problems.push(`These figures do not appear in any tool result: ${untraced.join(", ")}.`);
  if (usedTools && !citations.length) problems.push("The draft cites nothing; cite the tool results you used.");
  if (links.length) problems.push(`These links are not the url of any retrieved source: ${links.join(", ")}. Remove them.`);
  return { checks, citations, problems };
}
