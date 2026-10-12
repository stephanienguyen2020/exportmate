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

// Who the assistant works for. A signed-in company's profile comes from the backend
// (GET /api/v1/company/knowledge); without one, the demo company.
function workspace(company) {
  if (!company)
    return "The workspace belongs to Binh Duong Wood Co., a Vietnamese wood-products and furniture exporter. Its stock data is synthetic demo data; its news articles are real, from approved sources.";
  const c = company.company;
  return `You are working for ${c.name} (${c.businessRole}, based in ${c.origin}, primary market ${c.destination}). Its own company profile (what it does and makes, materials, certifications, sites, size, website) comes from get_company_profile. The stock items and news alerts in the other tools are synthetic demo data for a sample wood exporter, not ${c.name}'s own records: say so when you use them. News articles are real, from approved sources.`;
}

function system(company) {
  return `You are the ExportMate assistant, an AI agent inside ExportMate, a trade-compliance workspace.
${workspace(company)} Today is ${new Date().toISOString().slice(0, 10)}.

How to work:
- For anything about the company's stock, news alerts, news, sources or how to use ExportMate, call tools first, every time, including follow-up questions. Never answer those from memory; earlier answers in the conversation are not a data source.
${company ? "- For anything about the company itself (what it does, products, materials, certifications, sites, markets, size, website), call get_company_profile and cite it. Don't guess company details.\n" : ""}- query_inventory gives exact stock facts (SKUs, counts, totals, filters). get_alerts gives the news-scan alerts. search_knowledge searches the vector index of news articles, alerts, stock items, sources and help guides. get_scan_status reports scan and source health.
- get_alerts returns open alerts from every scan so far, not just the latest one. For what the latest (or today's) scan flagged, call get_alerts with latestScanOnly=true together with get_scan_status, and report only those alerts.
- Be thorough before answering. For questions about exposure, risk or impact, gather all relevant alerts with get_alerts (not just one search hit), check the items with query_inventory, and use search_knowledge for the underlying news. Call tools in parallel when you can, and again with refined arguments when results are thin.
- For exposure to a topic (e.g. "US plywood trade cases", "EUDR"), call get_alerts with topic keywords and no direction or severity filter: stock under "watch" and "opportunity" alerts is exposed too. If every returned alert is about the topic, report exposure.stockValueUsd (each SKU counted once) and cite exposure.ref. If some are off topic, call get_alerts again with the ids of the on-topic alerts and report that exposure instead. If nothing matches, retry with broader words or no keywords before saying no stock is exposed. Filter by direction or severity only when the user asks for just risks, opportunities or a severity.
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
      "News-impact alerts from the daily AI news scans, most severe first. By default it returns open alerts from every scan so far; set latestScanOnly for the most recent scan only. Each alert includes its headline, severity, direction, why it matters, every affected SKU (name, reason, stock value, markets, timber origin, geolocation status), the total stock value exposed, the next step and the source article. Also returns the exposure across all matching alerts: the distinct affected SKUs and their combined stock value, each SKU counted once. Filters combine with AND.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        latestScanOnly: { type: Type.BOOLEAN, description: "Only alerts raised by the most recent completed scan" },
        keywords: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description:
            "Topic filter: alerts whose headline, article title or explanation mentions any of these topic words, e.g. [\"plywood\", \"antidumping\"] or [\"EUDR\", \"deforestation\"]. Generic words (trade, case, court, market...) and country codes like US or EU are ignored, so it can return off-topic alerts; check each one.",
        },
        ids: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Only these alerts, by the id returned with each alert" },
        severity: { type: Type.STRING, enum: ["high", "medium", "low"], description: "Only when the user asks for this severity" },
        direction: {
          type: Type.STRING,
          enum: ["risk", "opportunity", "watch"],
          description: "Only when the user asks for just risks, opportunities or watch items",
        },
        skus: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Only alerts affecting any of these SKUs" },
        limit: { type: Type.INTEGER, description: "Alerts to return, default 10, max 30 (exposure always covers every match)" },
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
    description:
      "When the daily news scan last ran, how many articles it read and alerts it raised, the schedule, and each news source's status. For which alerts it raised, call get_alerts with latestScanOnly.",
  },
  {
    name: "get_company_profile",
    description:
      "The signed-in company's own profile from its ExportMate account (About company): name, role, where it is based, primary market, description, products, main materials and origin, certifications, website, year founded, team size and its sites. Only available in a company workspace.",
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

function citeScan(refs, s) {
  return refs.cite(`scan:${s.id}`, {
    type: "scan",
    id: s.id,
    title: `News scan, ${s.finishedAt.slice(0, 16).replace("T", " ")} UTC`,
    url: "#/workspace/news",
  });
}

// The most recent finished scan (a newer one may still be running or have failed).
async function lastDoneScan() {
  const snap = await scans.orderBy("startedAt", "desc").limit(5).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).find((s) => s.status === "done") ?? null;
}

// Names a filtered query in its citation, e.g. "skus=PLY-101/PLY-102, market=EU".
const describe = (args, skip) =>
  Object.entries(args)
    .filter(([k]) => !skip.includes(k))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : v}`)
    .join(", ");

// Keyword filter: phrases split into singular words of 3+ letters, minus words most trade news shares.
// A word matches at the start of a word, so "plywood" finds "plywood case" and "tariff" finds "tariffs".
const GENERIC = new Set(["trade", "case", "court", "news", "alert", "stock", "exposure", "exposed", "risk", "impact", "market", "company", "product", "goods", "rule", "regulation", "the", "and", "for", "with", "from", "about"]);
const topicPatterns = (keywords) =>
  [
    ...new Set(
      keywords
        .flatMap((k) => String(k).toLowerCase().match(/[a-z0-9]+/g) || [])
        .map((w) => w.replace(/(?<!s)s$/, ""))
        .filter((w) => w.length >= 3 && !GENERIC.has(w)),
    ),
  ].map((w) => new RegExp(`(^|[^a-z0-9])${w}`, "i"));

const TOOLS = {
  async get_company_profile(_args, refs, { company }) {
    if (!company) throw new Error("No company profile in this session.");
    const { id, updatedAt, ...profile } = company.company;
    const title = `${profile.name} · company profile (updated ${updatedAt.slice(0, 10)})`;
    const ref = refs.cite(`company:${id}`, { type: "company", id, title, url: "#/workspace/account" });
    return {
      output: { ref, ...profile, updatedAt: updatedAt.slice(0, 10), sites: company.sites },
      audit: { count: 1, results: [{ ref, type: "company", title }] },
    };
  },
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
    const filters = describe(args, ["limit", "sortBy"]);
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
    const [all, items, latest] = await Promise.all([
      cached("impacts", () => list(impacts)),
      cached("inventory", () => list(inventory)),
      args.latestScanOnly ? lastDoneScan() : null,
    ]);
    const bySku = new Map(items.map((i) => [i.sku, i]));
    const skus = (Array.isArray(args.skus) ? args.skus : []).map((k) => String(k).toUpperCase());
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
    const terms = topicPatterns(Array.isArray(args.keywords) ? args.keywords : []);
    const matching = all
      .filter(
        (a) =>
          (!ids.length || ids.includes(a.id)) &&
          (!args.latestScanOnly || a.scanId === latest?.id) &&
          (!args.severity || a.severity === args.severity) &&
          (!args.direction || a.direction === args.direction) &&
          (!skus.length || a.affected.some((x) => skus.includes(x.sku))) &&
          (!terms.length || terms.some((t) => t.test(`${a.headline} ${a.title} ${a.why}`))),
      )
      .sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || (b.publishedAt || "").localeCompare(a.publishedAt || ""));
    // Each affected SKU counted once across every matching alert, valued like query_inventory.
    const exposed = new Map();
    for (const a of matching)
      for (const x of a.affected) {
        const it = bySku.get(x.sku);
        exposed.set(x.sku, it ? Math.round(it.qtyOnHand * it.unitCostUsd) : x.stockValueUsd);
      }
    const exposure = [...exposed.values()].reduce((s, v) => s + v, 0);
    const filters = describe(args, ["limit"]);
    const exposureRef = refs.cite(`alerts:${filters}`, {
      type: "query",
      id: filters || "all",
      title: `Alert exposure${filters ? ` (${filters})` : ""}: ${matching.length} alerts, ${exposed.size} SKUs, USD ${exposure.toLocaleString("en-US")}`,
      url: "#/workspace/news",
    });
    const rows = matching
      .slice(0, clamp(args.limit, 1, 30, 10))
      .map((a) => ({
        ref: citeAlert(refs, a),
        id: a.id,
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
    const scope = !args.latestScanOnly
      ? "Open alerts from every scan so far"
      : latest
        ? `Only alerts raised by the latest scan, finished ${latest.finishedAt}`
        : "No scan has finished yet";
    return {
      output: {
        scope,
        latestScan: latest
          ? { ref: citeScan(refs, latest), finishedAt: latest.finishedAt, articlesAnalysed: latest.articlesAnalysed, alertsRaised: latest.impactsFound }
          : undefined,
        matching: matching.length,
        exposure: { ref: exposureRef, skus: [...exposed.keys()].sort(), stockValueUsd: exposure },
        alerts: rows,
      },
      audit: {
        count: rows.length,
        totalStockValueUsd: exposure,
        results: [
          { ref: exposureRef, type: "query", title: `${matching.length} matching alerts, ${exposed.size} SKUs, USD ${exposure.toLocaleString("en-US")} exposed` },
          ...rows.map((a) => ({ ref: a.ref, type: "alert", title: a.headline })),
        ],
      },
    };
  },

  async calculate({ expression }, refs) {
    const result = evaluate(expression);
    const ref = refs.cite(`calc:${expression}`, { type: "calculation", id: String(expression), title: `${expression} = ${result}` });
    return { output: { ref, expression, result }, audit: { count: 1, expression, result } };
  },

  async get_scan_status(_args, refs) {
    const [last, srcs] = await Promise.all([lastDoneScan(), cached("sources", () => list(sources))]);
    const output = {
      schedule: "Daily at 07:00 Asia/Ho_Chi_Minh (Cloud Scheduler)",
      lastScan: last && {
        ref: citeScan(refs, last),
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
export async function runAgent({ messages, sessionId, company = null, onStep = () => {} }) {
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
    companyId: company?.company.id,
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
          systemInstruction: system(company),
          tools: [{ functionDeclarations: company ? DECLARATIONS : DECLARATIONS.filter((d) => d.name !== "get_company_profile") }],
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
            const { output, audit: details } = await tool(c.args || {}, refs, { company });
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
