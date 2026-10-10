// The ExportMate assistant: a Gemini (Vertex AI) agent that plans, calls tools
// over Firestore and the vector index, answers with numbered citations, and
// records every step in an audit document (`audits` collection).
import { GoogleGenAI, Type, FunctionCallingConfigMode } from "@google/genai";
import { db, PROJECT, inventory, impacts, scans, sources, list } from "./db.js";
import { search, EMBED_MODEL, TYPES } from "./rag.js";

export const audits = db.collection("audits");
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_STEPS = 6;
const ai = new GoogleGenAI({
  vertexai: true,
  project: PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION || "global",
});

const cache = new Map();
async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}
export const clearCaches = () => cache.clear();

const clamp = (n, lo, hi, fallback) => (Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : fallback);
const has = (value, wanted) => !wanted || String(value).toLowerCase().includes(String(wanted).toLowerCase());
const SEVERITY = { high: 0, medium: 1, low: 2 };

function system() {
  return `You are the ExportMate assistant, an AI agent inside ExportMate, a trade-compliance workspace.
The workspace belongs to Binh Duong Wood Co., a Vietnamese wood-products and furniture exporter. Its stock data is synthetic demo data; its news articles are real, from approved sources. Today is ${new Date().toISOString().slice(0, 10)}.

How to work:
- For anything about the company's stock, news alerts, news, sources or how to use ExportMate, call tools first, every time, including follow-up questions. Never answer those from memory; earlier answers in the conversation are not a data source.
- query_inventory gives exact stock facts (SKUs, counts, totals, filters). get_alerts gives the daily news-scan alerts. search_knowledge searches the vector index of news articles, alerts, stock items, sources and help guides. get_scan_status reports scan and source health.
- Be thorough before answering. For questions about exposure, risk or impact, gather all relevant alerts with get_alerts (not just one search hit), check the items with query_inventory, and use search_knowledge for the underlying news. Call tools in parallel when you can, and again with refined arguments when results are thin.
- Take numbers only from tool results. For a total across several SKUs, call query_inventory with those skus and use its totalStockValueUsd (cite the query's ref), so each item is counted once. For any other arithmetic (sums, differences, averages, percentages) use calculate; never do math in your head.
- Cite every fact taken from a tool result with its ref number in square brackets, e.g. "PLY-103 has no geolocation data [3]." Cite only refs that appear in tool results, including calculate results. Don't add a reference list or explain the numbers; the app shows the sources.
- In follow-up questions, resolve references such as "those items" or "that alert" yourself by calling the tools again. Don't ask the user for anything the tools can look up; ask only when the request is genuinely ambiguous.
- Before saying something is absent ("none", "no items"), confirm it with a tool result that contains that field.
- If the tools don't contain the answer, say so plainly. Never invent SKUs, figures, dates, tariff rates or regulation details.
- General trade knowledge (e.g. what a certificate of origin is) can be answered without tools; mark regulatory specifics as things to verify with the official source. You are not a lawyer.
- Answer every part of the question, in the order asked, starting with the direct answer.
- Be concise: short paragraphs or bullets, money in USD. Reply in the user's language.`;
}

const DECLARATIONS = [
  {
    name: "search_knowledge",
    description:
      "Semantic search over ExportMate's vector database: real news articles from the approved sources, AI news alerts, stock items, news sources and ExportMate help guides. Best for topics, news, explanations and how-to questions. Returns the closest documents with their full text and a similarity score.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "A focused search query" },
        types: {
          type: Type.ARRAY,
          items: { type: Type.STRING, enum: TYPES },
          description: "Optional: only these document types",
        },
        limit: { type: Type.INTEGER, description: "Results to return, 1-10 (default 6)" },
      },
      required: ["query"],
    },
  },
  {
    name: "query_inventory",
    description:
      "Exact lookup of stock items. Returns each matching item's SKU, name, category, HS code, species, timber origin, supplier, markets, certifications, geolocation status, quantity, unit cost and stock value, plus the count and total stock value. Filters combine with AND. Market codes: EU, UK, US, CA, JP, KR, AU, and 'Raw material' for imported inputs.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        skus: { type: Type.ARRAY, items: { type: Type.STRING } },
        category: {
          type: Type.STRING,
          description:
            "Plywood, Hardwood plywood, Wooden furniture, Upholstered seating, Kitchen cabinets & vanities, Outdoor furniture, Engineered flooring, Wood pellets or Imported sawn timber",
        },
        market: { type: Type.STRING },
        hsCode: { type: Type.STRING, description: "HS code or prefix, e.g. 4412 or 9403.60" },
        species: { type: Type.STRING },
        timberOrigin: { type: Type.STRING, description: "Country the timber comes from" },
        supplier: { type: Type.STRING },
        certification: { type: Type.STRING, description: "e.g. FSC, VNTLAS, PEFC" },
        geolocationOnFile: { type: Type.BOOLEAN },
        sortBy: { type: Type.STRING, enum: ["stockValue", "quantity", "sku"] },
        limit: { type: Type.INTEGER, description: "Items to return, default 20, max 40" },
      },
    },
  },
  {
    name: "get_alerts",
    description:
      "News-impact alerts from the daily AI news scan, most severe first. Each alert includes its headline, severity, direction, why it matters, every affected SKU (name, reason, stock value, markets, timber origin, geolocation status), the total stock value exposed, the next step and the source article.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        severity: { type: Type.STRING, enum: ["high", "medium", "low"] },
        direction: { type: Type.STRING, enum: ["risk", "opportunity", "watch"] },
        skus: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Only alerts affecting any of these SKUs" },
        limit: { type: Type.INTEGER, description: "Default 10" },
      },
    },
  },
  {
    name: "calculate",
    description:
      "Exact arithmetic for sums, differences, averages and percentages. Use it instead of doing math yourself; the audit records each calculation.",
    parameters: {
      type: Type.OBJECT,
      properties: { expression: { type: Type.STRING, description: "Numbers with + - * / and parentheses, e.g. (535266 + 161128) / 2" } },
      required: ["expression"],
    },
  },
  {
    name: "get_scan_status",
    description: "When the daily news scan last ran, how many articles it read and alerts it raised, the schedule, and each news source's status.",
  },
];

/** Evaluates + - * / and parentheses over numbers, without eval. */
function evaluate(expression) {
  const src = String(expression || "").replace(/,/g, "");
  if (!src.trim() || src.length > 300 || !/^[\d\s+\-*/().]+$/.test(src)) throw new Error("Use only numbers, + - * / and parentheses");
  let i = 0;
  const skip = () => {
    while (src[i] === " ") i++;
  };
  const factor = () => {
    skip();
    if (src[i] === "-") {
      i++;
      return -factor();
    }
    if (src[i] === "(") {
      i++;
      const v = expr();
      skip();
      if (src[i++] !== ")") throw new Error("Missing )");
      return v;
    }
    const m = src.slice(i).match(/^\d+(\.\d+)?/);
    if (!m) throw new Error(`Unexpected "${src[i] ?? "end"}"`);
    i += m[0].length;
    return Number(m[0]);
  };
  const term = () => {
    let v = factor();
    for (skip(); src[i] === "*" || src[i] === "/"; skip()) {
      const op = src[i++];
      const r = factor();
      if (op === "/" && r === 0) throw new Error("Division by zero");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const expr = () => {
    let v = term();
    for (skip(); src[i] === "+" || src[i] === "-"; skip()) v = src[i++] === "+" ? v + term() : v - term();
    return v;
  };
  const value = expr();
  skip();
  if (i < src.length) throw new Error(`Unexpected "${src[i]}"`);
  return Math.round(value * 100) / 100;
}

function citeAlert(refs, a) {
  return refs.cite(`alert:${a.id}`, {
    type: "alert",
    id: a.id,
    title: a.headline,
    url: a.url,
    publishedAt: a.publishedAt,
    source: a.publisher,
  });
}

const TOOLS = {
  async search_knowledge({ query, types, limit }, refs) {
    const q = String(query || "").trim().slice(0, 300);
    if (!q) throw new Error("query is required");
    const hits = await search(q, { types: Array.isArray(types) ? types : undefined, limit: clamp(limit, 1, 10, 6) });
    const results = hits.map((h) => ({
      ref: refs.cite(h.id, { type: h.type, id: h.refId, title: h.title, url: h.url, publishedAt: h.publishedAt, source: h.source }),
      type: h.type,
      title: h.title,
      score: h.score,
      date: h.publishedAt?.slice(0, 10),
      text: h.text,
    }));
    return {
      output: { results },
      audit: { count: results.length, results: results.map(({ text, ...r }) => ({ ...r, excerpt: text.slice(0, 360) })) },
    };
  },

  async query_inventory(args, refs) {
    const items = await cached("inventory", () => list(inventory));
    const skus = Array.isArray(args.skus) ? args.skus.map((s) => String(s).toUpperCase()) : null;
    const rows = items
      .filter(
        (i) =>
          (!skus || skus.includes(i.sku)) &&
          has(i.category, args.category) &&
          (!args.market || i.markets.some((m) => m.toLowerCase() === String(args.market).toLowerCase())) &&
          (!args.hsCode || i.hsCode.replace(".", "").startsWith(String(args.hsCode).replace(".", ""))) &&
          has(i.species, args.species) &&
          has(i.timberOrigin, args.timberOrigin) &&
          has(i.supplier, args.supplier) &&
          (!args.certification || i.certifications.some((c) => has(c, args.certification))) &&
          (typeof args.geolocationOnFile !== "boolean" || i.geolocationOnFile === args.geolocationOnFile),
      )
      .map((i) => ({ ...i, stockValueUsd: Math.round(i.qtyOnHand * i.unitCostUsd) }));
    const sort = args.sortBy || "stockValue";
    rows.sort((a, b) =>
      sort === "sku" ? a.sku.localeCompare(b.sku) : sort === "quantity" ? b.qtyOnHand - a.qtyOnHand : b.stockValueUsd - a.stockValueUsd,
    );
    const shown = rows.slice(0, clamp(args.limit, 1, 40, 20)).map((i) => ({
      ref: refs.cite(`item:${i.sku}`, { type: "item", id: i.sku, title: `${i.sku} · ${i.name}`, url: "#/workspace/news" }),
      sku: i.sku,
      name: i.name,
      category: i.category,
      hsCode: i.hsCode,
      species: i.species,
      timberOrigin: i.timberOrigin,
      supplier: i.supplier,
      markets: i.markets,
      certifications: i.certifications,
      geolocationOnFile: i.geolocationOnFile,
      qtyOnHand: i.qtyOnHand,
      unit: i.unit,
      unitCostUsd: i.unitCostUsd,
      stockValueUsd: i.stockValueUsd,
      warehouse: i.warehouse,
    }));
    const total = rows.reduce((s, i) => s + i.stockValueUsd, 0);
    const filters = Object.entries(args)
      .filter(([k]) => !["limit", "sortBy"].includes(k))
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : v}`)
      .join(", ");
    // The query itself is citable, for counts and totals.
    const ref = refs.cite(`query:${filters}`, {
      type: "query",
      id: filters || "all",
      title: `Stock query${filters ? ` (${filters})` : ""}: ${rows.length} items, total USD ${total.toLocaleString("en-US")}`,
      url: "#/workspace/news",
    });
    return {
      output: { ref, matching: rows.length, totalStockValueUsd: total, items: shown },
      audit: {
        count: rows.length,
        totalStockValueUsd: total,
        results: [
          { ref, type: "query", title: `${rows.length} matching items, total USD ${total.toLocaleString("en-US")}` },
          ...shown.map((i) => ({ ref: i.ref, type: "item", title: `${i.sku} · ${i.name}` })),
        ],
      },
    };
  },

  async get_alerts(args, refs) {
    const [all, items] = await Promise.all([cached("impacts", () => list(impacts)), cached("inventory", () => list(inventory))]);
    const bySku = new Map(items.map((i) => [i.sku, i]));
    const rows = all
      .filter(
        (a) =>
          (!args.severity || a.severity === args.severity) &&
          (!args.direction || a.direction === args.direction) &&
          (!Array.isArray(args.skus) || !args.skus.length || a.affected.some((x) => args.skus.map((k) => String(k).toUpperCase()).includes(x.sku))),
      )
      .sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || (b.publishedAt || "").localeCompare(a.publishedAt || ""))
      .slice(0, clamp(args.limit, 1, 30, 10))
      .map((a) => ({
        ref: citeAlert(refs, a),
        severity: a.severity,
        direction: a.direction,
        headline: a.headline,
        why: a.why,
        action: a.action,
        affected: a.affected.map(({ sku, name, reason, stockValueUsd }) => ({
          sku,
          name,
          reason,
          stockValueUsd,
          markets: bySku.get(sku)?.markets,
          timberOrigin: bySku.get(sku)?.timberOrigin,
          geolocationOnFile: bySku.get(sku)?.geolocationOnFile,
        })),
        stockValueUsd: a.stockValueUsd,
        article: a.title,
        publisher: a.publisher,
        publishedAt: a.publishedAt?.slice(0, 10),
      }));
    return {
      output: { total: all.length, alerts: rows },
      audit: { count: rows.length, results: rows.map((a) => ({ ref: a.ref, type: "alert", title: a.headline })) },
    };
  },

  async calculate({ expression }, refs) {
    const result = evaluate(expression);
    const ref = refs.cite(`calc:${expression}`, { type: "calculation", id: String(expression), title: `${expression} = ${result}` });
    return { output: { ref, expression, result }, audit: { count: 1, expression, result } };
  },

  async get_scan_status(_args, refs) {
    const [snap, srcs] = await Promise.all([
      scans.orderBy("startedAt", "desc").limit(5).get(),
      cached("sources", () => list(sources)),
    ]);
    const last = snap.docs.map((d) => ({ id: d.id, ...d.data() })).find((s) => s.status === "done");
    const output = {
      schedule: "Daily at 07:00 Asia/Ho_Chi_Minh (Cloud Scheduler)",
      lastScan: last && {
        ref: refs.cite(`scan:${last.id}`, {
          type: "scan",
          id: last.id,
          title: `News scan, ${last.finishedAt.slice(0, 16).replace("T", " ")} UTC`,
          url: "#/workspace/news",
        }),
        finishedAt: last.finishedAt,
        trigger: last.trigger,
        lookbackDays: last.lookbackDays,
        articlesFetched: last.articlesFetched,
        articlesAnalysed: last.articlesAnalysed,
        alertsRaised: last.impactsFound,
      },
      sources: srcs.map((s) => ({
        ref: refs.cite(`source:${s.id}`, { type: "source", id: s.id, title: s.name, url: s.url }),
        name: s.name,
        enabled: s.enabled,
        builtIn: s.builtIn,
        lastFetchOk: s.lastOk,
        itemsLastFetch: s.lastCount,
        lastError: s.lastError || undefined,
      })),
    };
    return {
      output,
      audit: {
        count: output.sources.length,
        results: [
          ...(output.lastScan ? [{ ref: output.lastScan.ref, type: "scan", title: "Last news scan" }] : []),
          ...output.sources.map((s) => ({ ref: s.ref, type: "source", title: s.name })),
        ],
      },
    };
  },
};

function makeRefs() {
  const byKey = new Map();
  return {
    cite(key, info) {
      if (!byKey.has(key)) byKey.set(key, { ref: byKey.size + 1, ...info });
      return byKey.get(key).ref;
    },
    all: () => [...byKey.values()],
  };
}

const stripRefs = (text) => text.replace(/\s?\[\d+(?:\s*,\s*\d+)*\]/g, "");
const citedRefs = (text) => [
  ...new Set([...text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(/\s*,\s*/).map(Number))),
];
// Figures of 3+ digits, normalised ("1,165,971" -> "1165971", "520.50" -> "520.5").
const figures = (text) => [
  ...new Set(
    (stripRefs(text).match(/\d[\d,]*(?:\.\d+)?/g) || [])
      .map((n) => n.replace(/,/g, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""))
      .filter((n) => n.replace(".", "").length >= 3),
  ),
];

/** Auditor checks on an answer: citations resolve, figures come from evidence, tool use is cited. */
function review(answer, retrieved, evidence, usedTools) {
  const cited = citedRefs(answer);
  const citations = cited.map((n) => retrieved.find((r) => r.ref === n)).filter(Boolean);
  const invalid = cited.filter((n) => !retrieved.some((r) => r.ref === n));
  const untraced = usedTools ? figures(answer).filter((n) => !evidence.includes(n)) : [];
  const checks = [
    {
      name: "Citations point to retrieved evidence",
      ok: invalid.length === 0,
      detail: invalid.length ? `Unknown refs: ${invalid.join(", ")}` : `${citations.length} of ${retrieved.length} retrieved sources cited`,
    },
    {
      name: "Figures traceable to tool results",
      ok: untraced.length === 0,
      detail: !usedTools
        ? "No tools used"
        : untraced.length
          ? `Not found in tool results: ${untraced.join(", ")}`
          : `${figures(answer).length} figures checked`,
    },
    {
      name: "Answer grounded in tool results",
      ok: !usedTools || citations.length > 0,
      detail: usedTools ? (citations.length ? "Cites tool results" : "Tools were used but nothing is cited") : "No tools needed (general knowledge)",
    },
  ];
  const problems = [];
  if (invalid.length) problems.push(`Citations [${invalid.join("], [")}] do not match any tool result.`);
  if (untraced.length) problems.push(`These figures do not appear in any tool result: ${untraced.join(", ")}.`);
  if (usedTools && !citations.length) problems.push("The draft cites nothing; cite the tool results you used.");
  return { checks, citations, problems };
}

/**
 * Runs one agent turn. `messages` is the conversation ({role: "user"|"model", text}),
 * ending with the user's question. `onStep` receives audit steps as they happen.
 */
export async function runAgent({ messages, sessionId, onStep = () => {} }) {
  const started = Date.now();
  const refs = makeRefs();
  // Earlier answers lose their [n] markers (refs restart each turn) but keep the titles they cited.
  const contents = messages.map((m) => ({
    role: m.role,
    parts: [
      {
        text:
          m.role === "model"
            ? stripRefs(m.text) + (m.sources?.length ? `\n(Sources cited: ${m.sources.join("; ")})` : "")
            : m.text,
      },
    ],
  }));
  const audit = {
    sessionId,
    createdAt: new Date(started).toISOString(),
    question: messages.at(-1).text,
    model: MODEL,
    embeddingModel: EMBED_MODEL,
    steps: [],
    usage: { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, modelCalls: 0 },
    status: "ok",
  };
  const push = (step) => {
    const s = { at: Date.now() - started, ...step };
    audit.steps.push(s);
    onStep(s);
  };
  let answer = "";
  let revised = false;
  // Normalised text of everything the agent was given, for the figures check.
  let evidence = messages.map((m) => m.text).join(" ");
  const addEvidence = (text) => (evidence += " " + text.replace(/(\d),(?=\d{3})/g, "$1"));
  evidence = evidence.replace(/(\d),(?=\d{3})/g, "$1");

  try {
    for (let step = 0; step <= MAX_STEPS; step++) {
      const final = step === MAX_STEPS;
      const t0 = Date.now();
      const res = await ai.models.generateContent({
        model: MODEL,
        contents,
        config: {
          systemInstruction: system(),
          tools: [{ functionDeclarations: DECLARATIONS }],
          toolConfig: final ? { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } } : undefined,
          temperature: 0.2,
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingBudget: 512, includeThoughts: true },
        },
      });
      const u = res.usageMetadata || {};
      audit.usage.promptTokens += u.promptTokenCount || 0;
      audit.usage.outputTokens += u.candidatesTokenCount || 0;
      audit.usage.thinkingTokens += u.thoughtsTokenCount || 0;
      audit.usage.modelCalls += 1;
      const content = res.candidates?.[0]?.content || { role: "model", parts: [] };
      const parts = content.parts || [];
      const thought = parts.filter((p) => p.thought && p.text).map((p) => p.text).join("\n").trim() || undefined;
      const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
      const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      const tokens = { prompt: u.promptTokenCount, output: u.candidatesTokenCount, thinking: u.thoughtsTokenCount };

      if (!calls.length) {
        const usedTools = audit.steps.some((s) => s.kind === "tool");
        const { problems } = review(text, refs.all(), evidence, usedTools);
        if (problems.length && !revised && !final) {
          // One revision round: the auditor sends the draft back with its findings.
          revised = true;
          push({ kind: "draft", latencyMs: Date.now() - t0, thought, tokens, excerpt: text.slice(0, 800) });
          push({ kind: "review", problems });
          contents.push(content, {
            role: "user",
            parts: [
              {
                text: `Auditor review of your draft: ${problems.join(" ")} Verify with tools (for totals, call query_inventory with the skus) or remove what you cannot support, then give the corrected final answer.`,
              },
            ],
          });
          continue;
        }
        answer = text;
        push({ kind: "answer", latencyMs: Date.now() - t0, thought, tokens, finishReason: res.candidates?.[0]?.finishReason });
        if (final) audit.status = "max_steps";
        break;
      }
      push({
        kind: "plan",
        latencyMs: Date.now() - t0,
        thought,
        note: text || undefined,
        calls: calls.map((c) => ({ name: c.name, args: c.args || {} })),
        tokens,
      });
      contents.push(content);
      const responses = await Promise.all(
        calls.map(async (c) => {
          const t1 = Date.now();
          try {
            const tool = TOOLS[c.name];
            if (!tool) throw new Error(`Unknown tool ${c.name}`);
            const { output, audit: details } = await tool(c.args || {}, refs);
            addEvidence(JSON.stringify(output));
            push({ kind: "tool", name: c.name, args: c.args || {}, latencyMs: Date.now() - t1, ...details });
            return { functionResponse: { id: c.id, name: c.name, response: { output } } };
          } catch (e) {
            const error = String(e?.message || e);
            push({ kind: "tool", name: c.name, args: c.args || {}, latencyMs: Date.now() - t1, error });
            return { functionResponse: { id: c.id, name: c.name, response: { error } } };
          }
        }),
      );
      contents.push({ role: "user", parts: responses });
    }
  } catch (e) {
    console.error("Agent failed:", e);
    audit.status = "error";
    audit.error = String(e?.message || e);
  }

  const retrieved = refs.all();
  const { checks, citations } = review(answer, retrieved, evidence, audit.steps.some((s) => s.kind === "tool"));
  audit.checks = checks;
  Object.assign(audit, {
    answer: answer || (audit.status === "error" ? "" : "Sorry, I couldn't produce an answer."),
    citations,
    retrieved,
    latencyMs: Date.now() - started,
  });
  const ref = audits.doc();
  await ref.set(audit).catch((e) => console.error("Audit write failed:", e));
  return { id: ref.id, ...audit };
}
