// The critic: a Gemini judge for answers built on knowledge graph paths (query_graph). The
// auditor (review.js) checks what code can: refs resolve, figures appear in tool results, each
// order named from the graph cites its path. It can't tell whether a sentence says more than a
// path shows ("PO-2291 uses Lao acacia" when the path says Vietnam, or a supplier the path never
// names), so the critic compares, order by order, what the answer says connects it with its path.
// A draft it faults goes back once, like one the auditor faults. Only answers that used
// query_graph are judged, on the assistant's model at LOW thinking: a short judgement that
// must not misread a path, well inside the egress gateway's 60 s.
import { GoogleGenAI, Type } from "@google/genai";
import { withRetry } from "./gateway.js";
import { asData } from "./guard.js";
import { ASSISTANT, GEMINI_LOCATION, thinkingConfig } from "./models.js";
import { GEMINI_PROJECT } from "./db.js";

const MAX_PROBLEMS = 5;
const MODEL = ASSISTANT.model;
const THINKING = "LOW";
// The judgement usually takes about 3 s; twice in the 25 Nov exam it took 64 s and 98 s and held
// the answer back. Past this, the answer goes out with the auditor's checks alone.
export const CRITIC_TIMEOUT_MS = 20_000;

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    orders: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          orderId: { type: Type.STRING },
          supported: { type: Type.BOOLEAN, description: "False only when the answer adds to or contradicts this order's path" },
          problem: { type: Type.STRING, description: "When not supported: what the answer says, and what the path shows instead" },
        },
        required: ["orderId", "supported"],
      },
    },
  },
  required: ["orders"],
};

/** The knowledge graph paths query_graph returned this turn, from the tool steps' outputs. */
export function graphPaths(outputs) {
  return outputs
    .flatMap((o) => o?.matches ?? [])
    .map((m) => ({
      ref: m.ref,
      orderId: m.orderId,
      // The order's own facts, which the answer may give alongside its path.
      order: { product: m.product, supplier: m.supplier, destination: m.destination, market: m.market, shipDate: m.shipDate, status: m.status },
      path: m.path,
    }));
}

const orderFacts = (order = {}) =>
  Object.entries(order)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");

const describeStep = (s) => [s.link, s.label].filter(Boolean).join(": ") + (s.quote ? ` (source [${s.source}]: "${s.quote}")` : "");

/** The critic's prompt: each order's facts and path as data, then the answer, then what to judge. */
export function criticPrompt(answer, paths) {
  const listed = paths
    .map((p) => `<path ref="${p.ref}" order="${asData(p.orderId)}">\nOrder: ${asData(orderFacts(p.order))}\n${p.path.map((s) => `- ${asData(describeStep(s))}`).join("\n")}\n</path>`)
    .join("\n");
  return `You check an assistant's answer against the knowledge graph paths it was given. Each path connects one of the company's orders to what the question named. A path reads top to bottom: what the question named, the supplier and what it buys from which country, the form it buys, each step of the material chain ("used to make: <product>", with its source), and last the order (the order's own facts are given first).

${listed}

<answer>
${asData(answer)}
</answer>

For each order above, compare what the answer says connects that order (its supplier, the material, the country, the chain steps, the product) with its path. Give one entry per order.
- Supported: the answer restates, summarises or shortens the path, words it differently, writes HS codes differently, leaves steps out, gives the order's own facts, or doesn't mention the order.
- Not supported, only if the answer names a supplier, material, country or chain step for that order that its path doesn't contain, or says something that contradicts the path.
Order statuses, values, checklists, advice and background are not yours to judge.`;
}

/** The judge's JSON as { supported, problems }; anything malformed counts as supported (the auditor still ran). */
export function parseVerdict(text) {
  try {
    const verdict = JSON.parse(text || "{}");
    const faulted = (Array.isArray(verdict.orders) ? verdict.orders : []).filter((o) => o && o.supported === false && typeof o.problem === "string" && o.problem.trim());
    const problems = faulted.slice(0, MAX_PROBLEMS).map((o) => `${o.orderId}: ${o.problem.trim()}`);
    return { supported: problems.length === 0, problems };
  } catch {
    return { supported: true, problems: [] };
  }
}

let ai;
// Resolves to { text, tokens, attempts }: the tokens (thinking included) and tries go on the audit,
// so a slow verdict shows whether the model thought for long or the call was retried.
const defaultGenerate = async (prompt, abortSignal) => {
  ai ??= new GoogleGenAI({ vertexai: true, project: GEMINI_PROJECT, location: GEMINI_LOCATION });
  let attempts = 0;
  const res = await withRetry(() => {
    attempts++;
    return ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { responseMimeType: "application/json", responseSchema: SCHEMA, maxOutputTokens: 4096, thinkingConfig: thinkingConfig(MODEL, THINKING), abortSignal },
    });
  });
  const u = res.usageMetadata || {};
  return { text: res.text, tokens: { prompt: u.promptTokenCount, output: u.candidatesTokenCount, thinking: u.thoughtsTokenCount }, attempts };
};

/**
 * Judges whether the paths support the answer's claims about connections. Resolves to
 * { supported, problems, model } and never rejects: a judge that fails or takes over timeoutMs
 * (the request is then cancelled) leaves the answer to the auditor alone (`error` says why).
 */
export async function critique({ answer, paths, generate = defaultGenerate, timeoutMs = CRITIC_TIMEOUT_MS }) {
  if (!answer || !paths.length) return { supported: true, problems: [], skipped: true };
  const stop = new AbortController();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      stop.abort();
      reject(new Error(`no verdict within ${timeoutMs / 1000} s`));
    }, timeoutMs);
  });
  try {
    const out = await Promise.race([generate(criticPrompt(answer, paths), stop.signal), timedOut]);
    // generate resolves to the verdict's text, or to { text, tokens, attempts }.
    const { text, tokens, attempts } = typeof out === "string" ? { text: out } : out;
    return { ...parseVerdict(text), model: MODEL, ...(tokens && { tokens }), ...(attempts > 1 && { attempts }) };
  } catch (e) {
    return { supported: true, problems: [], error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}
