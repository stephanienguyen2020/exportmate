// Model router: each chat turn goes to the cheapest tier that can answer it well.
// - simple (small fast model): one lookup or explanation, e.g. a SKU's supplier, a count,
//   which items carry a certification, when the scan ran, how to use the app, a decline.
// - complex (bigger model): anything that needs the conversation so far, arithmetic over
//   several records, judgement about rules, risk or exposure, or text pasted from someone
//   else (a bigger model is better at not following instructions hidden in it).
// Rules, not a classifier call: free, instant and testable against the golden set. A simple-
// tier draft the auditor sends back is revised on the complex tier (agent.js).
import { findInjection } from "./guard.js";

const SKU = /\b[A-Z]{2,5}-\d{2,4}\b/gi;
const ARITHMETIC = /\b(total|combined|sum|average|mean|percent(age)?|share|ratio|difference|how much|exposure|exposed|margin)\b|%|tổng|trung bình|phần trăm/i;
const JUDGEMENT =
  /\b(why|should|recommend|advise|compare|comparison|versus|vs\.?|better|best|worst|prioriti[sz]e|matter most|impact|affect(s|ed)?|risks?|plan|strategy|what if|trade-?off)\b|tại sao|so sánh|rủi ro|ảnh hưởng|nên làm/i;
const RULES =
  /\b(eudr|cbam|lacey|anti-?dumping|countervailing|dut(y|ies)|tariffs?|quotas?|sanctions?|regulations?|complian(ce|t)|comply|due diligence|legal|law)\b|thuế|chống bán phá giá|quy định/i;
const QUOTED = /["“'‘][^"”'’]{40,}["”'’]/;
const LONG = 300;

const SIGNALS = [
  ["follow-up", (q, history) => history.length > 0],
  ["several SKUs", (q) => new Set((q.match(SKU) || []).map((s) => s.toUpperCase())).size > 1],
  ["arithmetic", (q) => ARITHMETIC.test(q)],
  ["judgement", (q) => JUDGEMENT.test(q)],
  ["trade rules", (q) => RULES.test(q)],
  ["pasted text", (q) => QUOTED.test(q) || q.split("\n").filter((l) => l.trim()).length > 3],
  ["instructions aimed at the assistant", (q) => Boolean(findInjection(q))],
  ["long question", (q) => q.length > LONG],
];

/**
 * The tier for a conversation ({role, text} messages ending with the user's question)
 * and the signals that chose it. `force` ("simple" | "complex") overrides, e.g. for evals.
 */
export function routeQuestion(messages, { force } = {}) {
  if (force) return { tier: force, reasons: ["forced"] };
  const question = String(messages.at(-1)?.text ?? "").normalize("NFC");
  const history = messages.slice(0, -1);
  const reasons = SIGNALS.filter(([, test]) => test(question, history)).map(([name]) => name);
  return { tier: reasons.length ? "complex" : "simple", reasons };
}
