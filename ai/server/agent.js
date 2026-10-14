// The ExportMate assistant: a Google ADK LlmAgent on Gemini (Vertex AI). ADK runs the
// ReAct loop (plan, call tools, observe, repeat) and holds the conversation in a
// session; the harness plugs into it:
// - policy.js: the prompt's rules, each tied to the failure it prevents (versioned);
// - gateway.js: every tool call is validated, scoped, budgeted, timed out and retried;
// - guard.js: third-party text in tool results is treated as data (injection removed);
// - review.js: an auditor checks the draft (citations, figures, links) and sends it back once;
// - router.js: each question goes to a small fast model or the bigger one (models.js);
// - answer-cache.js: a question already answered against the same data isn't answered again.
// Every step is streamed and stored in an audit document (`audits` collection).
import { FieldValue } from "@google-cloud/firestore";
import { BasePlugin, BaseTool, Gemini, InMemorySessionService, LlmAgent, Runner, createEvent, isToolNotFound, LogLevel, setLogger } from "@google/adk";
import { Type, FunctionCallingConfigMode } from "@google/genai";
import { db, PROJECT, inventory, impacts, scans, sources, answerCache, list } from "./db.js";
import { search, EMBED_MODEL, TYPES } from "./rag.js";
import { evaluate } from "./calc.js";
import { ToolError, toolGateway, withRetry } from "./gateway.js";
import { ORDER_STATUSES, matchOrders, presentOrder, totalsByCurrency } from "./orders.js";
import { createGuard } from "./guard.js";
import { POLICY_VERSION, rulesFor } from "./policy.js";
import { review, stripRefs, toEvidence } from "./review.js";
import { log } from "./log.js";
import { ANONYMOUS, itemVisible, presentSources, visibleItems } from "./access.js";
import { TIERS, thinkingFor } from "./models.js";
import { routeQuestion } from "./router.js";
import { answerKey, cacheable, cachedAudit, fingerprint, CACHE_TTL_MS } from "./answer-cache.js";
import { GUIDES } from "./seed/guides.js";

export const audits = db.collection("audits");
const MAX_STEPS = 6;
const TOOL_BUDGET = 16;
const APP = "exportmate";
const AGENT = "exportmate_assistant";

// ADK's Gemini model, with transient errors (429, 503, timeouts) retried with backoff.
// The attempt count rides on the response so the audit can show retried steps.
class RetryingGemini extends Gemini {
  async *generateContentAsync(request, stream, abortSignal) {
    let attempts = 0;
    const responses = await withRetry(async () => {
      attempts++;
      const out = [];
      for await (const r of super.generateContentAsync(request, stream, abortSignal)) out.push(r);
      return out;
    });
    for (const r of responses) yield { ...r, customMetadata: { ...r.customMetadata, attempts } };
  }
}
// One client for both tiers: each call names its model (beforeModelCallback in runAgent).
const gemini = new RetryingGemini({
  model: TIERS.simple.model,
  vertexai: true,
  project: PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION || "global",
});

// Describes the Cloud Scheduler job; set it where the job is configured.
const SCAN_SCHEDULE = process.env.SCAN_SCHEDULE || "Daily at 07:00 Asia/Ho_Chi_Minh (Cloud Scheduler)";

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
const ageDays = (iso) => (iso && !isNaN(Date.parse(iso)) ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)) : undefined);
const SEVERITY = { high: 0, medium: 1, low: 2 };
// Stock categories and markets, as enums so the gateway rejects anything else.
const CATEGORIES = ["Plywood", "Hardwood plywood", "Wooden furniture", "Upholstered seating", "Kitchen cabinets & vanities", "Outdoor furniture", "Engineered flooring", "Wood pellets", "Imported sawn timber"];
const MARKETS = ["EU", "UK", "US", "CA", "JP", "KR", "AU", "Raw material"];
// Document types whose text comes from third parties (news feeds, or alerts written from them).
const UNTRUSTED_TYPES = new Set(["article", "alert", "source"]);

// Who the assistant works for. A signed-in company's profile comes from the backend
// (GET /api/v1/company/knowledge); without one, the demo company, whose orders and
// playbook the browser sends with the question (when it has them).
function workspace(company, session) {
  if (!company)
    return `The workspace belongs to Binh Duong Wood Co., a Vietnamese wood-products and furniture exporter, in ExportMate's browser demo. ${session.orders ? "Its sample orders (order ids such as PO-2291, values, ship dates, statuses and the demo's one sample rule check) come from query_orders; they include any the user imported. " : ""}${session.playbook ? "Its playbook rules come from get_playbook. " : ""}Its stock data is synthetic demo data, separate from its orders; its news articles are real, from approved sources.`;
  const c = company.company;
  return `You are working for ${c.name} (${c.businessRole}, based in ${c.origin}, primary market ${c.destination}). Its own company profile (what it does and makes, materials, certifications, sites, size, website) comes from get_company_profile, its own orders (order ids such as PO-2291, values, ship dates, statuses and each order's document checklist) from query_orders, and its playbook rules from get_playbook. The stock items and news alerts in the other tools are synthetic demo data for a sample wood exporter, not ${c.name}'s own records: say so when you use them. News articles are real, from approved sources.`;
}

function system(company, session) {
  return `You are the ExportMate assistant, an AI agent inside ExportMate, a trade-compliance workspace.
${workspace(company, session)} Today is ${new Date().toISOString().slice(0, 10)}.

How to work:
${rulesFor(session)
  .map((r) => `- ${r.text}`)
  .join("\n")}`;
}

// Where query_orders and get_playbook read from: the company backend with the caller's own
// token, or the orders and playbook the browser demo sent (orders.js checked them).
function workspaceReaders(backend, demo) {
  if (backend) {
    const read = async (path, what) => {
      const { status, body } = await backend(path);
      if (status !== 200)
        throw status === 0 || status >= 500
          ? Object.assign(new Error(`The company's ${what} can't be read right now.`), { status: 503 })
          : new ToolError("denied", `This account can't read the company's ${what}.`);
      return body.data;
    };
    return {
      orders: async () => (await read("/api/v1/trade-map", "orders")).orders,
      playbook: async () => (await read("/api/v1/playbook/rules", "playbook")).filter((r) => r.enabled),
    };
  }
  return {
    orders: demo?.orders ? async () => demo.orders : null,
    playbook: demo?.playbook ? async () => demo.playbook : null,
  };
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

const withFlags = (audit, guard) => (guard.flags.length ? { ...audit, flags: guard.flags } : audit);

// Tool registry: what the model may ask for, who may use it and the handler that runs it.
// Every tool is read-only (least privilege): the assistant can look things up, never change them.
// scope "company" tools are offered and allowed only in a signed-in company workspace.
const REGISTRY = {
  search_knowledge: {
    scope: "public",
    declaration: {
      name: "search_knowledge",
      description:
        "Semantic search over ExportMate's vector database: real news articles from the approved sources, AI news alerts, stock items, news sources and ExportMate help guides. Best for topics, news, explanations and how-to questions. Returns the closest documents with their full text, a similarity score and, for news, its age in days.",
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
    async run({ query, types, limit }, { refs, access }) {
      const q = String(query || "").trim().slice(0, 300);
      if (!q) throw new Error("query is required");
      const guard = createGuard();
      // Only articles, alerts and sources this company may see (another company's custom feeds stay out).
      const byId = new Map((await cached("sources", () => list(sources))).map((s) => [s.id, s]));
      const hits = await search(q, { types, limit: clamp(limit, 1, 10, 6), filter: (h) => itemVisible(h, byId, access) });
      const results = hits.map((h) => {
        const untrusted = UNTRUSTED_TYPES.has(h.type);
        const title = untrusted ? guard.clean(h.title, `${h.type} ${h.refId} title`) : h.title;
        return {
          ref: refs.cite(h.id, { type: h.type, id: h.refId, title, url: h.url, publishedAt: h.publishedAt, source: h.source }),
          type: h.type,
          title,
          score: h.score,
          lexical: h.lexical,
          date: h.publishedAt?.slice(0, 10),
          ageDays: ageDays(h.publishedAt),
          text: untrusted ? guard.clean(h.text, `${h.type} ${h.refId}`) : h.text,
        };
      });
      return {
        output: { results },
        audit: withFlags({ count: results.length, results: results.map(({ text, ...r }) => ({ ...r, excerpt: text.slice(0, 360) })) }, guard),
      };
    },
  },

  query_inventory: {
    scope: "public",
    declaration: {
      name: "query_inventory",
      description:
        "Exact lookup of stock items. Returns each matching item's SKU, name, category, HS code, species, timber origin, supplier, markets, certifications, geolocation status, quantity, unit cost and stock value, plus the count and total stock value. Filters combine with AND. Market codes: EU, UK, US, CA, JP, KR, AU, and 'Raw material' for imported inputs.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          skus: { type: Type.ARRAY, items: { type: Type.STRING } },
          category: { type: Type.STRING, enum: CATEGORIES, description: "Exact category; Plywood does not include Hardwood plywood" },
          market: { type: Type.STRING, enum: MARKETS },
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
    async run(args, { refs }) {
      const items = await cached("inventory", () => list(inventory));
      const skus = args.skus ? args.skus.map((s) => s.toUpperCase()) : null;
      const rows = items
        .filter(
          (i) =>
            (!skus || skus.includes(i.sku)) &&
            (!args.category || i.category.toLowerCase() === args.category.toLowerCase()) &&
            (!args.market || i.markets.some((m) => m.toLowerCase() === args.market.toLowerCase())) &&
            (!args.hsCode || i.hsCode.replace(".", "").startsWith(args.hsCode.replace(".", ""))) &&
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
  },

  get_alerts: {
    scope: "public",
    declaration: {
      name: "get_alerts",
      description:
        "News-impact alerts from the daily AI news scans, most severe first. By default it returns open alerts from every scan so far; set latestScanOnly for the most recent scan only. Each alert includes its headline, severity, direction, why it matters, every affected SKU (name, reason, stock value, markets, timber origin, geolocation status), the total stock value exposed, the next step and the source article with its age in days. Also returns the exposure across all matching alerts: the distinct affected SKUs and their combined stock value, each SKU counted once. Filters combine with AND.",
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
    async run(args, { refs, access }) {
      const [stored, items, latest, srcs] = await Promise.all([
        cached("impacts", () => list(impacts)),
        cached("inventory", () => list(inventory)),
        args.latestScanOnly ? lastDoneScan() : null,
        cached("sources", () => list(sources)),
      ]);
      const all = visibleItems(stored, srcs, access);
      const guard = createGuard();
      const bySku = new Map(items.map((i) => [i.sku, i]));
      const skus = (args.skus || []).map((k) => k.toUpperCase());
      const ids = args.ids || [];
      const terms = topicPatterns(args.keywords || []);
      const matching = all
        .filter(
          (a) =>
            (a.status || "open") === "open" &&
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
      const rows = matching.slice(0, clamp(args.limit, 1, 30, 10)).map((a) => {
        // Alerts are written by the scan model from third-party articles, so their text is checked too.
        const headline = guard.clean(a.headline, `alert ${a.id} headline`);
        return {
          ref: citeAlert(refs, { ...a, headline }),
          id: a.id,
          severity: a.severity,
          direction: a.direction,
          headline,
          why: guard.clean(a.why, `alert ${a.id}`),
          action: guard.clean(a.action, `alert ${a.id} next step`),
          affected: a.affected.map(({ sku, name, reason, stockValueUsd }) => ({
            sku,
            name,
            reason: guard.clean(reason, `alert ${a.id} ${sku}`),
            stockValueUsd,
            markets: bySku.get(sku)?.markets,
            timberOrigin: bySku.get(sku)?.timberOrigin,
            geolocationOnFile: bySku.get(sku)?.geolocationOnFile,
          })),
          stockValueUsd: a.stockValueUsd,
          article: guard.clean(a.title, `alert ${a.id} article title`),
          publisher: a.publisher,
          publishedAt: a.publishedAt?.slice(0, 10),
          ageDays: ageDays(a.publishedAt),
        };
      });
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
        audit: withFlags(
          {
            count: rows.length,
            totalStockValueUsd: exposure,
            results: [
              { ref: exposureRef, type: "query", title: `${matching.length} matching alerts, ${exposed.size} SKUs, USD ${exposure.toLocaleString("en-US")} exposed` },
              ...rows.map((a) => ({ ref: a.ref, type: "alert", title: a.headline, ageDays: a.ageDays })),
            ],
          },
          guard,
        ),
      };
    },
  },

  calculate: {
    scope: "public",
    declaration: {
      name: "calculate",
      description:
        "Exact arithmetic for sums, differences, averages and percentages. Use it instead of doing math yourself; the audit records each calculation.",
      parameters: {
        type: Type.OBJECT,
        properties: { expression: { type: Type.STRING, description: "Numbers with + - * / and parentheses, e.g. (535266 + 161128) / 2" } },
        required: ["expression"],
      },
    },
    async run({ expression }, { refs }) {
      const result = evaluate(expression);
      const ref = refs.cite(`calc:${expression}`, { type: "calculation", id: String(expression), title: `${expression} = ${result}` });
      return { output: { ref, expression, result }, audit: { count: 1, expression, result } };
    },
  },

  get_scan_status: {
    scope: "public",
    declaration: {
      name: "get_scan_status",
      description:
        "When the daily news scan last ran, how many articles it read and alerts it raised, the schedule, and each news source's status. For which alerts it raised, call get_alerts with latestScanOnly.",
    },
    async run(_args, { refs, access }) {
      const [last, stored] = await Promise.all([lastDoneScan(), cached("sources", () => list(sources))]);
      const srcs = presentSources(stored, access); // `enabled` as it applies to this company
      const guard = createGuard();
      const output = {
        schedule: SCAN_SCHEDULE,
        lastScan: last && {
          ref: citeScan(refs, last),
          finishedAt: last.finishedAt,
          trigger: last.trigger,
          lookbackDays: last.lookbackDays,
          articlesFetched: last.articlesFetched,
          articlesAnalysed: last.articlesAnalysed,
          alertsRaised: last.impactsFound,
        },
        sources: srcs.map((s) => {
          // Custom source names are typed by users; treat them like feed text.
          const name = s.builtIn ? s.name : guard.clean(s.name, `source ${s.id} name`);
          return {
            ref: refs.cite(`source:${s.id}`, { type: "source", id: s.id, title: name, url: s.url }),
            name,
            enabled: s.enabled,
            builtIn: s.builtIn,
            lastFetchOk: s.lastOk,
            itemsLastFetch: s.lastCount,
            lastError: s.lastError || undefined,
          };
        }),
      };
      return {
        output,
        audit: withFlags(
          {
            count: output.sources.length,
            results: [
              ...(output.lastScan ? [{ ref: output.lastScan.ref, type: "scan", title: "Last news scan" }] : []),
              ...output.sources.map((s) => ({ ref: s.ref, type: "source", title: s.name })),
            ],
          },
          guard,
        ),
      };
    },
  },

  get_company_profile: {
    scope: "company",
    declaration: {
      name: "get_company_profile",
      description:
        "The signed-in company's own profile from its ExportMate account (About company): name, role, where it is based, primary market, description, products, main materials and origin, certifications, website, year founded, team size and its sites. Only available in a company workspace.",
    },
    async run(_args, { refs, company }) {
      const { id, updatedAt, ...profile } = company.company;
      const title = `${profile.name} · company profile (updated ${updatedAt.slice(0, 10)})`;
      const ref = refs.cite(`company:${id}`, { type: "company", id, title, url: "#/workspace/account" });
      return {
        output: { ref, ...profile, updatedAt: updatedAt.slice(0, 10), sites: company.sites },
        audit: { count: 1, results: [{ ref, type: "company", title }] },
      };
    },
  },

  query_orders: {
    scope: "orders",
    // Read live (Postgres, or the browser demo's own orders), outside the answer cache's data fingerprint.
    live: true,
    declaration: {
      name: "query_orders",
      description:
        "The company's own orders (the Orders page), read live: order id (e.g. PO-2291), product, supplier, destination and market, value and currency, ship date, HS code, status (exposed is shown as \"Action needed\") and each order's document checklist: every line's status (on_file, missing, mismatch, prepare, check, unknown), a note and the official text it comes from (the browser demo has one sample check per order it covers, with no official text). Also returns the count and total value per currency of all matches. Filters combine with AND; with none, every order.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          ids: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Order ids, e.g. PO-2291" },
          query: { type: Type.STRING, description: "Text in the order id, product, supplier, destination or HS code" },
          status: { type: Type.STRING, enum: ORDER_STATUSES },
          limit: { type: Type.INTEGER, description: "Orders to return, default 10, max 30 (count and totals cover every match)" },
        },
      },
    },
    async run(args, { refs, orders: readOrders }) {
      const matching = matchOrders(await readOrders(), args);
      const totals = totalsByCurrency(matching);
      const filters = describe(args, ["limit"]);
      const totalText = Object.entries(totals).map(([c, v]) => `${c} ${v.toLocaleString("en-US")}`).join(" + ") || "no value";
      const ref = refs.cite(`orders:${filters}`, {
        type: "query",
        id: filters || "all",
        title: `Order query${filters ? ` (${filters})` : ""}: ${matching.length} orders, ${totalText}`,
        url: "#/workspace/orders",
      });
      const orders = matching.slice(0, clamp(args.limit, 1, 30, 10)).map((m) => presentOrder(m, refs.cite));
      return {
        output: { ref, matching: matching.length, totalValueByCurrency: totals, orders },
        audit: {
          count: matching.length,
          results: [
            { ref, type: "query", title: `${matching.length} matching orders, ${totalText}` },
            ...orders.map((o) => ({ ref: o.ref, type: "order", title: `${o.id} · ${o.product} · ${o.statusLabel}` })),
          ],
        },
      };
    },
  },

  get_playbook: {
    scope: "playbook",
    // The company's own rules, read live (Postgres, or the browser demo's), so never fingerprinted.
    live: true,
    declaration: {
      name: "get_playbook",
      description:
        "The company's playbook (the Playbook page): the trading rules it wrote itself and switched on, each with its category (Policy, Threshold, Supplier, Watchlist) and text. Its preferences for how to judge orders, suppliers and news, not regulations.",
    },
    async run(_args, { refs, playbook }) {
      const rules = (await playbook()).map((r) => ({
        ref: refs.cite(`playbook:${r.id}`, {
          type: "playbook",
          id: String(r.id),
          title: `Playbook · ${r.category}: ${r.text.length > 80 ? `${r.text.slice(0, 80)}…` : r.text}`,
          url: "#/workspace/playbook",
        }),
        category: r.category,
        text: r.text,
      }));
      return {
        output: { count: rules.length, rules },
        audit: { count: rules.length, results: rules.map((r) => ({ ref: r.ref, type: "playbook", title: `${r.category}: ${r.text}` })) },
      };
    },
  },
};

// Tools that read data outside the answer cache's fingerprint (answer-cache.js).
const LIVE_TOOLS = new Set(Object.keys(REGISTRY).filter((name) => REGISTRY[name].live));

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

// A registry tool as an ADK tool. ADK decides when to call it; the gateway still runs it.
class GatewayTool extends BaseTool {
  constructor(declaration, run) {
    super({ name: declaration.name, description: declaration.description });
    this.declaration = declaration;
    this.run = run;
  }
  _getDeclaration() {
    return this.declaration;
  }
  runAsync({ args }) {
    return this.run(this.name, args);
  }
}

// ADK answers calls to tools it wasn't given (made-up names, company tools outside a
// company workspace) itself; this sends them through the gateway so the refusal is audited.
class UnknownToolPlugin extends BasePlugin {
  constructor(run) {
    super("unknown_tool_gateway");
    this.run = run;
  }
  async onToolErrorCallback({ tool, toolArgs }) {
    return isToolNotFound(tool) ? this.run(tool.name, toolArgs) : undefined;
  }
}

// ADK's own log lines go through log.js (JSON on Cloud Run); its per-request info lines are dropped.
const adkLog = (severity) => (...args) => log(severity, `adk.${severity.toLowerCase()}`, { detail: args.join(" ").slice(0, 500) });
const adkWarn = adkLog("WARNING");
const adkError = adkLog("ERROR");
setLogger({
  log: (level, ...args) => (level >= LogLevel.ERROR ? adkError(...args) : level >= LogLevel.WARN ? adkWarn(...args) : undefined),
  debug: () => {},
  info: () => {},
  warn: adkWarn,
  error: adkError,
  setLogLevel: () => {},
});

// Answer cache (answer-cache.js). Help guides change only with a deploy, so their hash is fixed.
const GUIDES_VERSION = fingerprint(GUIDES);
const MODELS = { simple: TIERS.simple.model, complex: TIERS.complex.model };
let scanSeen;

// Everything the tools read for this caller, as one hash: stock, the sources as this company
// sees them (with their last fetch), the latest finished scan (its articles and alerts), the
// company profile and the guides. A cached answer is only reused while this is unchanged.
async function dataVersion(company, access, session) {
  const scan = await lastDoneScan();
  // A scan on another instance: drop this instance's copies so tools and the key agree.
  if (scan?.id !== scanSeen) {
    clearCaches();
    scanSeen = scan?.id;
  }
  const [items, stored] = await Promise.all([cached("inventory", () => list(inventory)), cached("sources", () => list(sources))]);
  // Which order and playbook tools were offered: they change the prompt, though what they read is live.
  const tools = { orders: Boolean(session.orders), playbook: Boolean(session.playbook) };
  return fingerprint({ items, sources: presentSources(stored, access), scan: scan?.id ?? null, company, tools, guides: GUIDES_VERSION });
}

// The audit that answered this key before, if it is still there and still fit to reuse.
async function cachedAnswer(key, companyId = null) {
  const entry = await answerCache.doc(key).get();
  if (!entry.exists || entry.get("expireAt")?.toMillis() < Date.now()) return null;
  const doc = await audits.doc(entry.get("auditId")).get();
  if (!doc.exists) return null;
  const original = { id: doc.id, ...doc.data() };
  // The key already names the company; checked again so an entry can never cross companies.
  return (original.companyId ?? null) === companyId && cacheable(original, LIVE_TOOLS) ? original : null;
}

/**
 * Runs one agent turn. `messages` is the conversation ({role: "user"|"model", text}),
 * ending with the user's question. `onStep` receives audit steps as they happen.
 * `channel` says where the turn came from ("chat" or "eval"); `withEvidence` also
 * returns the tool-result text the answer was checked against (not stored). `tier` forces
 * a model tier (router.js); `useCache` reuses and stores answers (answer-cache.js).
 */
export async function runAgent({
  messages,
  sessionId,
  company = null,
  // Which news sources this company sees (access.js); defaults to none switched off.
  access = company ? { companyId: company.company.id, disabled: [] } : ANONYMOUS,
  requestId,
  channel = "chat",
  withEvidence = false,
  tier,
  useCache = channel === "chat",
  // GETs a company backend path with the caller's own token ({ status, body }); company chats only.
  backend = null,
  // The browser demo's own orders and playbook ({ orders, playbook }, from orders.js); demo chats only.
  demo = null,
  onStep = () => {},
}) {
  const started = Date.now();
  const companyId = company?.company.id;
  const readers = workspaceReaders(backend, company ? null : demo);
  // What this turn's tools and rules may use (gateway.js scopes, policy.js `when`).
  const session = { company, orders: readers.orders, playbook: readers.playbook };

  // Asked and answered before, against the same data today: reuse that answer.
  let key = null;
  if (useCache) {
    try {
      key = answerKey({
        messages,
        companyId,
        disabled: access.disabled,
        dataVersion: await dataVersion(company, access, session),
        policyVersion: POLICY_VERSION,
        models: MODELS,
        day: new Date(started).toISOString().slice(0, 10),
      });
      const original = await cachedAnswer(key, companyId);
      if (original) {
        const audit = cachedAudit(original, { sessionId, requestId, channel, companyId, question: messages.at(-1).text, startedAt: started, latencyMs: Date.now() - started });
        onStep(audit.steps[0]);
        const ref = audits.doc();
        await ref.set(audit).catch((e) => log("ERROR", "audit.write_failed", { requestId, error: String(e?.message || e) }));
        answerCache.doc(key).update({ hits: FieldValue.increment(1), lastHitAt: new Date().toISOString() }).catch(() => {});
        return { id: ref.id, ...audit };
      }
    } catch (e) {
      log("WARNING", "answer_cache.read_failed", { requestId, error: String(e?.message || e) });
    }
  }

  const route = routeQuestion(messages, { force: tier });
  let current = route.tier; // a simple-tier draft the auditor sends back is revised on the complex tier
  let callModel = TIERS[current].model;
  const refs = makeRefs();
  const gateway = toolGateway(REGISTRY, { refs, access, ...session }, { maxCalls: TOOL_BUDGET });
  const audit = {
    sessionId,
    requestId,
    channel,
    companyId,
    createdAt: new Date(started).toISOString(),
    question: messages.at(-1).text,
    model: TIERS[current].model,
    route: { tier: route.tier, reasons: route.reasons },
    embeddingModel: EMBED_MODEL,
    policyVersion: POLICY_VERSION,
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
  let revision = null; // the auditor's findings, sent back as the next message
  let step = -1;
  let stepStarted = started;
  // Normalised text the figures check accepts: the user's own messages and this turn's tool results.
  // Earlier model turns come from the client, so they can't vouch for a figure.
  let evidence = toEvidence(messages.filter((m) => m.role === "user").map((m) => m.text).join(" "));

  // Every tool call, offered or not, runs through the gateway and is recorded.
  async function runTool(name, args = {}) {
    const r = await gateway.call(name, args);
    if (r.ok) evidence += " " + toEvidence(JSON.stringify(r.output));
    push({
      kind: "tool",
      name,
      args,
      latencyMs: r.latencyMs,
      ...(r.attempts > 1 ? { attempts: r.attempts } : {}),
      ...(r.ok ? r.details : { error: r.error, errorKind: r.errorKind }),
    });
    return r.ok ? { output: r.output } : { error: r.error };
  }

  // Records each model response as a plan, draft or answer step. A final answer that
  // fails the auditor goes back once (not on the last step).
  function observe(res) {
    const u = res.usageMetadata || {};
    audit.usage.promptTokens += u.promptTokenCount || 0;
    audit.usage.outputTokens += u.candidatesTokenCount || 0;
    audit.usage.thinkingTokens += u.thoughtsTokenCount || 0;
    audit.usage.modelCalls += 1;
    const parts = res.content?.parts || [];
    const thought = parts.filter((p) => p.thought && p.text).map((p) => p.text).join("\n").trim() || undefined;
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const tokens = { prompt: u.promptTokenCount, output: u.candidatesTokenCount, thinking: u.thoughtsTokenCount };
    const attempts = res.customMetadata?.attempts;
    const meta = { model: callModel, ...(attempts > 1 ? { attempts } : {}) };
    const latencyMs = Date.now() - stepStarted;
    const final = step >= MAX_STEPS;

    if (calls.length) {
      push({ kind: "plan", latencyMs, thought, note: text || undefined, calls: calls.map((c) => ({ name: c.name, args: c.args || {} })), tokens, ...meta });
      return;
    }
    const usedTools = audit.steps.some((s) => s.kind === "tool");
    const { problems } = review({ answer: text, retrieved: refs.all(), evidence, usedTools });
    if (problems.length && !revised && !final) {
      revised = true;
      push({ kind: "draft", latencyMs, thought, tokens, ...meta, excerpt: text.slice(0, 800) });
      push({ kind: "review", problems });
      if (current === "simple") {
        current = "complex";
        audit.route.escalated = true;
      }
      revision = `Auditor review of your draft: ${problems.join(" ")} Verify with tools (for totals, call query_inventory with the skus) or remove what you cannot support, then give the corrected final answer.`;
      return;
    }
    answer = text;
    audit.model = callModel;
    push({ kind: "answer", latencyMs, thought, tokens, ...meta, finishReason: res.finishReason });
    if (final) audit.status = "max_steps";
  }

  // Built per turn: the prompt names this company and the tools close over this turn's gateway.
  const agent = new LlmAgent({
    name: AGENT,
    description: "Answers trade-compliance questions about the workspace's stock, news alerts, company profile and orders, with citations.",
    model: gemini,
    // A function, not a string, so ADK doesn't read {braces} in the policy as state placeholders.
    instruction: () => system(company, session),
    // A single agent: no transfers, which also keeps ADK's identity preamble out of the versioned prompt.
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
    tools: gateway.declarations().map((d) => new GatewayTool(d, runTool)),
    generateContentConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096,
    },
    beforeModelCallback: ({ request }) => {
      step++;
      stepStarted = Date.now();
      // Past the last step (the model called a tool anyway): end the turn without an answer.
      if (step > MAX_STEPS) {
        audit.status = "max_steps";
        return { content: { role: "model", parts: [{ text: "" }] } };
      }
      // The routed tier's model and thinking level for this call.
      callModel = TIERS[current].model;
      request.model = callModel;
      request.config = { ...request.config, thinkingConfig: thinkingFor(current) };
      // The last step has to answer: tools are switched off.
      if (step === MAX_STEPS) request.config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } };
      return undefined;
    },
    afterModelCallback: ({ response }) => {
      observe(response);
      return undefined;
    },
  });
  const sessions = new InMemorySessionService();
  const runner = new Runner({ appName: APP, agent, sessionService: sessions, plugins: [new UnknownToolPlugin(runTool)] });
  const userId = company?.company.id || "demo";

  try {
    // The conversation so far comes from the client. Earlier answers lose their [n] markers
    // (refs restart each turn) but keep the titles they cited.
    const session = await sessions.createSession({ appName: APP, userId });
    for (const m of messages.slice(0, -1)) {
      const text = m.role === "model" ? stripRefs(m.text) + (m.sources?.length ? `\n(Sources cited: ${m.sources.join("; ")})` : "") : m.text;
      await sessions.appendEvent({
        session,
        event: createEvent({ author: m.role === "model" ? AGENT : "user", content: { role: m.role, parts: [{ text }] } }),
      });
    }
    // The question, then the auditor's findings if the draft is sent back.
    let message = messages.at(-1).text;
    while (message) {
      const newMessage = { role: "user", parts: [{ text: message }] };
      for await (const event of runner.runAsync({ userId, sessionId: session.id, newMessage })) {
        // ADK turns a model error (after our retries) into an event; it ends the turn.
        if (event.errorCode) throw Object.assign(new Error(event.errorMessage || event.errorCode), { status: Number(event.errorCode) || undefined });
      }
      [message, revision] = [revision, null];
    }
  } catch (e) {
    log("ERROR", "agent.failed", { requestId, error: String(e?.message || e), status: e?.status });
    audit.status = "error";
    audit.error = String(e?.message || e);
  }

  const retrieved = refs.all();
  const { checks, citations } = review({ answer, retrieved, evidence, usedTools: audit.steps.some((s) => s.kind === "tool") });
  // An answer that still fails the auditor after its revision is shown, flagged for a person to check.
  if (audit.status === "ok" && checks.some((c) => !c.ok)) audit.status = "needs_review";
  const flags = audit.steps.flatMap((s) => s.flags || []);
  Object.assign(audit, {
    answer: answer || (audit.status === "error" ? "" : "Sorry, I couldn't produce an answer."),
    checks,
    citations,
    retrieved,
    ...(flags.length ? { flags } : {}),
    latencyMs: Date.now() - started,
  });
  const ref = audits.doc();
  const stored = await ref.set(audit).then(
    () => true,
    (e) => log("ERROR", "audit.write_failed", { requestId, error: String(e?.message || e) }),
  );
  if (stored && key && cacheable(audit, LIVE_TOOLS))
    await answerCache
      .doc(key)
      .set({ auditId: ref.id, companyId: companyId ?? null, createdAt: audit.createdAt, expireAt: new Date(started + CACHE_TTL_MS), hits: 0 })
      .catch((e) => log("WARNING", "answer_cache.write_failed", { requestId, error: String(e?.message || e) }));
  return { id: ref.id, ...audit, ...(withEvidence ? { evidence } : {}) };
}
