// The assistant's tools: what a model may ask for, who may use it and the handler that runs
// it. Every tool is read-only. The gateway (gateway.js) runs each call; the guard (guard.js)
// cleans third-party text in results; `refs` numbers every citable result for the auditor.
import { BasePlugin, BaseTool, isToolNotFound } from "@google/adk";
import { Type } from "@google/genai";
import { inventory, impacts, scans, sources, list } from "../db.js";
import { search, TYPES } from "../rag.js";
import { evaluate } from "../calc.js";
import { ToolError } from "../gateway.js";
import { CHECKLIST_DETAILS, ORDER_STATUSES, matchOrders, ordersQuery, presentOrder, presentSource, totalsByCurrency } from "../orders.js";
import { createGuard } from "../guard.js";
import { itemVisible, presentScan, presentSources, visibleItems } from "../access.js";

// Describes the Cloud Scheduler job; set it where the job is configured.
const SCAN_SCHEDULE = process.env.SCAN_SCHEDULE || "Daily at 07:00 Asia/Ho_Chi_Minh (Cloud Scheduler)";

const cache = new Map();
export async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}
export const clearCaches = () => cache.clear();

const clamp = (n, lo, hi, fallback) => (Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : fallback);
const has = (value, wanted) => !wanted || String(value).toLowerCase().includes(String(wanted).toLowerCase());
// An item's stock value; a company's goods have no quantity or cost, so none.
const stockValue = (i) => (Number.isFinite(i?.qtyOnHand * i?.unitCostUsd) ? Math.round(i.qtyOnHand * i.unitCostUsd) : undefined);
// The turn's stock (agent.js): a company's own goods, or the sample stock in the browser demo.
const stockOf = async (ctx) => ctx.stock ?? (await cached("inventory", () => list(inventory)));
const ageDays = (iso) => (iso && !isNaN(Date.parse(iso)) ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)) : undefined);
const SEVERITY = { high: 0, medium: 1, low: 2 };
// Document types whose text comes from third parties (news feeds, or alerts written from them).
const UNTRUSTED_TYPES = new Set(["article", "alert", "source"]);
// GET /orders' largest page: query_orders reads every match up to it.
const MAX_ORDERS = 200;

// Where query_orders and get_playbook read from: the company backend with the caller's own
// token, or the orders and playbook the browser demo sent (orders.js checked them).
export function workspaceReaders(backend, demo) {
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
      // Every match (up to MAX_ORDERS), so the count and totals cover them all.
      orders: async (args = {}) => read(`/api/v1/orders?${ordersQuery(args, MAX_ORDERS)}`, "orders"),
      playbook: async () => (await read("/api/v1/playbook/rules", "playbook")).filter((r) => r.enabled),
      graph: async (args) => read(`/api/v1/knowledge-graph/query?${graphQuery(args)}`, "knowledge graph"),
      // GET /api/v1/orders/{id}/what-if: a 404 or 422 (unknown order, market or route; the same
      // market or date) goes back to the model with the backend's message, so it can correct the call.
      whatIf: async ({ orderId, ...change }) => {
        const { status, body } = await backend(`/api/v1/orders/${encodeURIComponent(orderId)}/what-if?${new URLSearchParams(change)}`);
        if (status === 404 || status === 422) throw new ToolError("invalid_args", body?.error?.message || `No what-if for ${orderId}.`);
        if (status !== 200) throw Object.assign(new Error("The what-if can't be worked out right now."), { status: 503 });
        return body.data;
      },
      changes: async (days) => read(`/api/v1/market-requirements/changes${days ? `?days=${days}` : ""}`, "rule changes"),
    };
  }
  // The browser demo has no backend, so no knowledge graph to walk.
  return {
    orders: demo?.orders ? async (args = {}) => matchOrders(demo.orders, args) : null,
    playbook: demo?.playbook ? async () => demo.playbook : null,
    graph: null,
    whatIf: null,
    changes: null,
  };
}

// query_graph's arguments as the backend's query string (each list parameter repeated).
export function graphQuery({ materials = [], countries = [], hsCodes = [], markets = [], includeShipped = false }) {
  const params = new URLSearchParams();
  for (const [name, values] of [["material", materials], ["country", countries], ["hsCode", hsCodes], ["market", markets]])
    for (const value of values) params.append(name, value);
  if (includeShipped) params.set("includeShipped", "true");
  return params.toString();
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
export async function lastDoneScan() {
  const snap = await scans.orderBy("startedAt", "desc").limit(5).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).find((s) => s.status === "done") ?? null;
}

// Names a filtered query in its citation, e.g. "skus=A-101/A-102, market=EU".
const describe = (args, skip) =>
  Object.entries(args)
    .filter(([k]) => !skip.includes(k))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : v}`)
    .join(", ");

// Keyword filter: phrases split into singular words of 3+ letters, minus words most trade news shares.
// A word matches at the start of a word, so "dumping" finds "dumping case" and "tariff" finds "tariffs".
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

/**
 * The registry with query_inventory's category and market filters limited to what the stock
 * holds, so the model sees the real names and the gateway rejects anything else.
 */
export function withStockLists(registry, items) {
  const tool = registry.query_inventory;
  const { parameters } = tool.declaration;
  const listed = (values) => [...new Set(values.filter(Boolean))].sort();
  const limit = (schema, values) => (values.length ? { ...schema, enum: values } : schema);
  const properties = {
    ...parameters.properties,
    category: limit(parameters.properties.category, listed(items.map((i) => i.category))),
    market: limit(parameters.properties.market, listed(items.flatMap((i) => i.markets || []))),
  };
  return { ...registry, query_inventory: { ...tool, declaration: { ...tool.declaration, parameters: { ...parameters, properties } } } };
}

// Tool registry: what the model may ask for, who may use it and the handler that runs it.
// Every tool is read-only (least privilege): the assistant can look things up, never change them.
// scope "company" tools are offered and allowed only in a signed-in company workspace.
export const REGISTRY = {
  search_knowledge: {
    scope: "public",
    // Answers that went round in circles searched 4 to 9 times; good ones needed at most 3.
    maxCalls: 3,
    declaration: {
      name: "search_knowledge",
      description:
        "Semantic search over ExportMate's vector database: real news articles from the approved sources, AI news alerts, stock items, news sources and ExportMate help guides. Best for topics, news, explanations and how-to questions. Returns the closest documents with their full text, a similarity score and, for news, its age in days. At most 3 searches per question: make each query cover the whole topic rather than one word at a time.",
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
        "Exact lookup of the workspace's stock items: in a company workspace, the company's own goods (the products its profile names and its orders ship, each with the ids of those orders; no quantities or values); in the browser demo, the sample stock. Returns what each matching item has of SKU, name, category, HS code, main material and the country it comes from, supplier, markets, certifications, whether its origin is traced, quantity, unit cost and stock value, plus the count and, when items have values, the total stock value. Filters combine with AND.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          skus: { type: Type.ARRAY, items: { type: Type.STRING } },
          // The stock's own categories and markets fill these enums each turn (withStockLists).
          category: { type: Type.STRING, description: "Exact category: one category, not the ones whose names contain it" },
          market: { type: Type.STRING, description: "A market the item is sold to" },
          hsCode: { type: Type.STRING, description: "HS code or prefix, with or without the dot" },
          material: { type: Type.STRING, description: "Part of the main material's name" },
          materialOrigin: { type: Type.STRING, description: "Country the main material comes from" },
          supplier: { type: Type.STRING },
          certification: { type: Type.STRING, description: "Part of a certification's name" },
          originTraced: {
            type: Type.BOOLEAN,
            description:
              "false: only items whose origin is not traced to where the material was produced (records such as plot geolocation for EU deforestation rules, or farm and lot records for food traceability rules); true: only items with those records. Filter here rather than reading each item.",
          },
          sortBy: { type: Type.STRING, enum: ["stockValue", "quantity", "sku"] },
          limit: { type: Type.INTEGER, description: "Items to return, default 20, max 40" },
        },
      },
    },
    async run(args, ctx) {
      const { refs } = ctx;
      const items = await stockOf(ctx);
      const skus = args.skus ? args.skus.map((s) => s.toUpperCase()) : null;
      const digits = (hs) => String(hs ?? "").replace(/\D/g, "");
      const rows = items
        .filter(
          (i) =>
            (!skus || skus.includes(i.sku)) &&
            (!args.category || String(i.category ?? "").toLowerCase() === args.category.toLowerCase()) &&
            (!args.market || (i.markets || []).some((m) => m.toLowerCase() === args.market.toLowerCase())) &&
            (!args.hsCode || (digits(i.hsCode) && digits(i.hsCode).startsWith(digits(args.hsCode)))) &&
            has(i.material, args.material) &&
            has(i.materialOrigin, args.materialOrigin) &&
            has(i.supplier, args.supplier) &&
            (!args.certification || (i.certifications || []).some((c) => has(c, args.certification))) &&
            (typeof args.originTraced !== "boolean" || i.originTraced === args.originTraced),
        )
        .map((i) => ({ ...i, stockValueUsd: stockValue(i) }));
      const sort = args.sortBy || "stockValue";
      const number = (n) => (Number.isFinite(n) ? n : -1);
      rows.sort((a, b) =>
        sort === "sku"
          ? a.sku.localeCompare(b.sku)
          : sort === "quantity"
            ? number(b.qtyOnHand) - number(a.qtyOnHand)
            : number(b.stockValueUsd) - number(a.stockValueUsd),
      );
      const shown = rows.slice(0, clamp(args.limit, 1, 40, 20)).map((i) => ({
        ref: refs.cite(`item:${i.sku}`, { type: "item", id: i.sku, title: `${i.sku} · ${i.name}`, url: "#/workspace/news" }),
        sku: i.sku,
        name: i.name,
        category: i.category,
        hsCode: i.hsCode,
        material: i.material,
        materialOrigin: i.materialOrigin,
        supplier: i.supplier,
        markets: i.markets,
        certifications: i.certifications,
        originTraced: i.originTraced,
        qtyOnHand: i.qtyOnHand,
        unit: i.unit,
        unitCostUsd: i.unitCostUsd,
        stockValueUsd: i.stockValueUsd,
        warehouse: i.warehouse,
        orders: i.orders,
      }));
      const valued = rows.filter((i) => Number.isFinite(i.stockValueUsd));
      const total = valued.length ? valued.reduce((s, i) => s + i.stockValueUsd, 0) : undefined;
      const totalText = total === undefined ? "" : `, total USD ${total.toLocaleString("en-US")}`;
      const filters = describe(args, ["limit", "sortBy"]);
      // The query itself is citable, for counts and totals.
      const ref = refs.cite(`query:${filters}`, {
        type: "query",
        id: filters || "all",
        title: `Stock query${filters ? ` (${filters})` : ""}: ${rows.length} items${totalText}`,
        url: "#/workspace/news",
      });
      return {
        output: { ref, matching: rows.length, totalStockValueUsd: total, items: shown },
        audit: {
          count: rows.length,
          totalStockValueUsd: total,
          results: [
            { ref, type: "query", title: `${rows.length} matching items${totalText}` },
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
        "News-impact alerts from the daily AI news scans, most severe first. By default it returns open alerts from every scan so far; set latestScanOnly for the most recent scan only. Each alert includes its headline, severity, direction, why it matters, every affected item by SKU (name, reason, markets, and what the item has of stock value, material origin, whether its origin is traced and the orders it comes from), the total stock value exposed when items have values, the next step and the source article with its age in days. Also returns the exposure across all matching alerts: the distinct affected SKUs, each counted once, and their combined stock value when they have one. In a company workspace the alerts are about the company's own goods. Filters combine with AND.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          latestScanOnly: { type: Type.BOOLEAN, description: "Only alerts raised by the most recent completed scan" },
          keywords: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description:
              "Topic filter: alerts whose headline, article title or explanation mentions any of these topic words, e.g. a product and a measure ([\"steel\", \"antidumping\"]) or a rule's name and subject. Generic words (trade, case, court, market...) and country codes like US or EU are ignored, so it can return off-topic alerts; check each one.",
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
    async run(args, ctx) {
      const { refs, access } = ctx;
      const [stored, items, latest, srcs] = await Promise.all([
        cached("impacts", () => list(impacts)),
        stockOf(ctx),
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
          exposed.set(x.sku, it ? stockValue(it) : x.stockValueUsd);
        }
      const values = [...exposed.values()].filter(Number.isFinite);
      const exposure = values.length ? values.reduce((s, v) => s + v, 0) : undefined;
      const exposureText = exposure === undefined ? "" : `, USD ${exposure.toLocaleString("en-US")}`;
      const filters = describe(args, ["limit"]);
      const exposureRef = refs.cite(`alerts:${filters}`, {
        type: "query",
        id: filters || "all",
        title: `Alert exposure${filters ? ` (${filters})` : ""}: ${matching.length} alerts, ${exposed.size} SKUs${exposureText}`,
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
            materialOrigin: bySku.get(sku)?.materialOrigin,
            originTraced: bySku.get(sku)?.originTraced,
            orders: bySku.get(sku)?.orders,
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
            ? { ref: citeScan(refs, latest), finishedAt: latest.finishedAt, articlesAnalysed: latest.articlesAnalysed, alertsRaised: presentScan(latest, access).impactsFound }
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
              { ref: exposureRef, type: "query", title: `${matching.length} matching alerts, ${exposed.size} SKUs${exposureText}${exposure === undefined ? "" : " exposed"}` },
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
      const [done, stored] = await Promise.all([lastDoneScan(), cached("sources", () => list(sources))]);
      const last = presentScan(done, access);
      const srcs = presentSources(stored, access); // `enabled` as it applies to this company
      const guard = createGuard();
      const output = {
        schedule: SCAN_SCHEDULE,
        lastScan: last && {
          ref: citeScan(refs, last),
          finishedAt: last.finishedAt,
          trigger: last.trigger,
          maxAgeDays: last.maxAgeDays,
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
        "GET /api/v1/orders: the company's own orders (the Orders page), read live, by ship date: order id (e.g. PO-2291), product, supplier, destination and market, value and currency, ship date, HS code, status (exposed is shown as \"Action needed\") and gap count (checklist lines missing or mismatched). checklist adds each order's document checklist: \"gaps\" (default) only the missing or mismatched lines, \"all\" every line with its status (on_file, missing, mismatch, prepare, check, unknown); each line has a note and the official text it comes from (the browser demo has one sample check per order it covers, with no official text). Use \"all\" for a few named orders or for lines that aren't gaps (what is on file, which orders need ISPM 15 packaging). Also returns the count and total value per currency of all matches. Filters combine with AND; with none, every order.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          status: { type: Type.STRING, enum: ORDER_STATUSES },
          q: { type: Type.STRING, description: "Text in the order id, product, supplier, destination or HS code" },
          market: { type: Type.STRING, description: "Destination market code, e.g. EU, US, UK, JP, SG, KR" },
          id: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Order ids, e.g. PO-2291" },
          checklist: { type: Type.STRING, enum: CHECKLIST_DETAILS, description: "none, gaps (default) or all" },
          limit: { type: Type.INTEGER, description: "Orders to return, default 10, max 30 (count and totals cover every match)" },
        },
      },
    },
    async run(args, { refs, orders: readOrders }) {
      const matching = await readOrders(args);
      const totals = totalsByCurrency(matching);
      const filters = describe(args, ["limit", "checklist"]);
      const totalText = Object.entries(totals).map(([c, v]) => `${c} ${v.toLocaleString("en-US")}`).join(" + ") || "no value";
      const ref = refs.cite(`orders:${filters}`, {
        type: "query",
        id: filters || "all",
        title: `Order query${filters ? ` (${filters})` : ""}: ${matching.length} orders, ${totalText}`,
        url: "#/workspace/orders",
      });
      const orders = matching.slice(0, clamp(args.limit, 1, 30, 10)).map((o) => presentOrder(o, refs.cite));
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

// One path step as the model reads it: how it follows from the step before, and the official
// text that says so, cited.
function presentStep(step, refs) {
  const source = step.sourceUrl
    ? refs.cite(`chain-source:${step.sourceUrl}`, { type: "chain_source", id: step.sourceUrl, title: step.sourceTitle || step.sourceUrl, url: step.sourceUrl })
    : undefined;
  return {
    kind: step.kind,
    label: step.label,
    ...(step.link ? { link: step.link } : {}),
    ...(source ? { source, quote: step.quote } : {}),
    ...(step.doubt ? { doubt: step.doubt } : {}),
  };
}

REGISTRY.query_graph = {
  scope: "graph",
  // The company's orders and sourcing, read live from the backend.
  live: true,
  declaration: {
    name: "query_graph",
    description:
      "Walks the company's knowledge graph (GraphRAG): which of its orders a material, an origin country, a product or HS code, or a market reaches, and how. Each match is an order with its path: the supplier that buys the material (and from where), then each step of the material chain (e.g. logs → veneer → plywood) with the official text that defines it, ending at the order. Use it for questions about connections and what-ifs: \"which orders depend on acacia from Laos?\", \"what if Vietnam restricts acacia log exports?\" (materials [\"acacia logs\"], countries [\"VN\"]), \"which orders use plywood?\". `understood` says what the graph recognised; `unknown` lists what it didn't. Open orders only unless includeShipped.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        materials: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Materials or products as words: a species (acacia, oil palm), a broad word (timber, hardwood) or a chain product (logs, plywood, cocoa butter); at most 8" },
        countries: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Countries the materials come from, ISO alpha-2 (VN, LA, ID); at most 8" },
        hsCodes: { type: Type.ARRAY, items: { type: Type.STRING }, description: "HS codes, 4 to 10 digits (4403, 4412.33); at most 8" },
        markets: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Markets the orders ship to: EU, US, UK, … or a country code (NL counts as EU); at most 8" },
        includeShipped: { type: Type.BOOLEAN, description: "Also orders that have shipped (default false)" },
      },
    },
  },
  async run(args, { refs, graph }) {
    if (!["materials", "countries", "hsCodes"].some((k) => args[k]?.length))
      throw new ToolError("invalid_args", "Name at least one material, origin country or HS code.");
    const found = await graph(args);
    const filters = describe(args, []);
    const ref = refs.cite(`graph:${filters}`, {
      type: "query",
      id: filters,
      title: `Knowledge graph walk (${filters}): ${found.matches.length} of ${found.ordersChecked} orders reached`,
      url: "#/workspace/chain",
    });
    const matches = found.matches.map((m) => ({
      ref: refs.cite(`path:${m.orderId}:${filters}`, {
        type: "path",
        id: m.orderId,
        title: `${m.orderId} · ${m.reason}`,
        url: `#/workspace/orders/${encodeURIComponent(m.orderId)}`,
      }),
      orderId: m.orderId,
      product: m.product,
      supplier: m.supplier,
      destination: m.destination,
      market: m.market,
      shipDate: m.shipDate,
      status: m.status,
      via: m.via === "supplier" ? "through its supplier's sourcing and the material chain" : "same HS heading",
      reason: m.reason,
      path: m.path.map((step) => presentStep(step, refs)),
    }));
    return {
      output: { ref, ordersChecked: found.ordersChecked, understood: found.understood, matches },
      audit: {
        count: matches.length,
        results: [
          { ref, type: "query", title: `${matches.length} of ${found.ordersChecked} orders reached` },
          ...matches.map((m) => ({ ref: m.ref, type: "path", title: `${m.orderId} · ${m.reason}` })),
        ],
      },
    };
  },
};

// Tools that read data outside the answer cache's fingerprint (answer-cache.js).
const WHAT_IF_ROUTES = ["direct", "SG", "MY", "HK", "AE", "LK"];

REGISTRY.compare_order = {
  scope: "whatIf",
  // Works the comparison out live from the company's orders, suppliers and checklists.
  live: true,
  declaration: {
    name: "compare_order",
    description:
      "GET /api/v1/orders/{orderId}/what-if: what one change to one order would mean for its paperwork, worked out from the company's own checklists and supplier documents (the trade map's \"What if\" panel). Give exactly one change: market (another destination market), shipDate (another ship date) or via (a stop on the route). Returns reuse (documents on file that still apply, to review), reevaluate (what to redo or prepare; tag New, Changes or Prepare), unknown (what the data can't answer, e.g. duty or freight), dropped (requirements the change removes) and assumptions; a route also has distanceKm (great-circle, not a voyage). Market comparisons cover paperwork only. For a what-if about a material or an origin country (\"what if Vietnam restricts acacia logs\"), use query_graph instead.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        orderId: { type: Type.STRING, description: "The order, e.g. PO-2291" },
        market: { type: Type.STRING, description: "Another destination market code: EU, US, UK, JP, SG, KR, CA, AU" },
        shipDate: { type: Type.STRING, description: "Another ship date, YYYY-MM-DD (\"a month later\": add a month to the order's ship date from query_orders)" },
        via: { type: Type.STRING, enum: WHAT_IF_ROUTES, description: "A stop on the route: SG Singapore, MY Port Klang, HK Hong Kong, AE Jebel Ali, LK Colombo; direct for none" },
      },
      required: ["orderId"],
    },
  },
  async run(args, { refs, whatIf }) {
    const changes = ["market", "shipDate", "via"].filter((k) => args[k]);
    if (changes.length !== 1) throw new ToolError("invalid_args", "Give exactly one change: market, shipDate or via.");
    const [kind] = changes;
    const result = await whatIf({ orderId: args.orderId, [kind]: args[kind] });
    const change = kind === "market" ? `went to ${result.toMarket}` : kind === "shipDate" ? `shipped on ${result.toShipDate}` : `went via ${result.viaName}`;
    const counts = `reuse ${result.reuse.length}, recheck ${result.reevaluate.length}, unknown ${result.unknown.length}, no longer needed ${result.dropped.length}`;
    const ref = refs.cite(`whatif:${result.orderId}:${kind}=${args[kind]}`, {
      type: "query",
      id: `${result.orderId} ${kind}=${args[kind]}`,
      title: `What if ${result.orderId} ${change}: ${counts}`,
      url: `#/workspace/map/order/${encodeURIComponent(result.orderId)}`,
    });
    const { routePoints: _points, ...comparison } = result;
    return {
      output: { ref, ...comparison },
      audit: { count: result.reuse.length + result.reevaluate.length + result.unknown.length, results: [{ ref, type: "query", title: `What if ${result.orderId} ${change}: ${counts}` }] },
    };
  },
};

REGISTRY.upcoming_changes = {
  scope: "changes",
  // The company's markets and checklists, read live.
  live: true,
  declaration: {
    name: "upcoming_changes",
    description:
      "GET /api/v1/market-requirements/changes: checklist lines in the markets the company's open orders ship to that take effect (kind effective) or change (kind changes) between today and `days` from now, oldest first (Rule watch's \"Coming up\"). Each has its date (on), market, title, whatChanges, the official text it comes from, and orderIds: the open orders to that market and product that ship on or after that date. Set days so the window reaches the latest ship date that matters (default 90, at most 365). These are dated lines in the company's own checklists; news about proposed rules comes from search_knowledge.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        days: { type: Type.INTEGER, description: "How far ahead, 1–365 days (default 90)" },
      },
    },
  },
  async run(args, { refs, changes: readChanges }) {
    const days = args.days === undefined ? undefined : clamp(args.days, 1, 365, 90);
    const found = await readChanges(days);
    const ref = refs.cite(`changes:${found.start}:${found.until}`, {
      type: "query",
      id: `${found.start} to ${found.until}`,
      title: `Checklist changes from ${found.start} to ${found.until}: ${found.changes.length}`,
      url: "#/workspace/rules",
    });
    const changes = found.changes.map((c) => ({
      on: c.on,
      kind: c.kind,
      market: c.market,
      marketName: c.marketName,
      title: c.title,
      whatChanges: c.whatChanges,
      orderIds: c.orderIds,
      source: presentSource(c.source, refs.cite),
    }));
    return {
      output: { ref, start: found.start, until: found.until, days: found.days, changes },
      audit: {
        count: changes.length,
        results: [
          { ref, type: "query", title: `Checklist changes from ${found.start} to ${found.until}: ${changes.length}` },
          ...changes.map((c) => ({ ref: c.source.ref, type: "regulation", title: `${c.on} ${c.market}: ${c.title}` })),
        ],
      },
    };
  },
};

export const LIVE_TOOLS = new Set(Object.keys(REGISTRY).filter((name) => REGISTRY[name].live));

export function makeRefs() {
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
export class GatewayTool extends BaseTool {
  constructor(declaration, run) {
    super({ name: declaration.name, description: declaration.description });
    this.declaration = declaration;
    this.run = run;
  }
  _getDeclaration() {
    return this.declaration;
  }
  // The calling agent's name goes with the call, so the audit says which agent used the tool.
  runAsync({ args, toolContext }) {
    return this.run(this.name, args, toolContext?.agentName);
  }
}

// ADK answers calls to tools it wasn't given (made-up names, company tools outside a
// company workspace) itself; this sends them through the gateway so the refusal is audited.
export class UnknownToolPlugin extends BasePlugin {
  constructor(run) {
    super("unknown_tool_gateway");
    this.run = run;
  }
  async onToolErrorCallback({ tool, toolArgs, toolContext }) {
    return isToolNotFound(tool) ? this.run(tool.name, toolArgs, toolContext?.agentName) : undefined;
  }
}

