// Daily news scan: read enabled sources, ask Gemini on Vertex AI which stock
// items each new article could affect, and store the results in Firestore.
// Runs from POST /api/scan (Cloud Scheduler or the UI) or `npm run scan`.
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { GoogleGenAI, Type } from "@google/genai";
import { db, PROJECT, inventory, sources, articles, impacts, scans, list } from "./db.js";
import { fetchFeed } from "./feeds.js";
import { indexDocs, toDoc } from "./rag.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "global";
const LOOKBACK_DAYS = 3; // daily runs overlap a little so nothing is missed
const FIRST_RUN_LOOKBACK_DAYS = 14;
const MAX_NEW_ARTICLES = 80;
const BATCH = 16;

const ai = new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION });
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 20);

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    assessments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          index: { type: Type.INTEGER, description: "Article number from the list" },
          relevant: { type: Type.BOOLEAN },
          severity: { type: Type.STRING, enum: ["high", "medium", "low"] },
          direction: { type: Type.STRING, enum: ["risk", "opportunity", "watch"] },
          headline: { type: Type.STRING, description: "What changed, in under 15 words" },
          why: { type: Type.STRING, description: "How it affects this company's stock, 1-2 sentences" },
          affected: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { sku: { type: Type.STRING }, reason: { type: Type.STRING } },
              required: ["sku", "reason"],
            },
          },
          action: { type: Type.STRING, description: "One concrete next step" },
          sameAs: { type: Type.INTEGER, description: "Index of an article reporting the same event, if any" },
        },
        required: ["index", "relevant"],
      },
    },
  },
  required: ["assessments"],
};

function catalog(items) {
  return items
    .map(
      (i) =>
        `${i.sku} | ${i.name} | ${i.category} | HS ${i.hsCode} | ${i.species} from ${i.timberOrigin} | supplier ${i.supplier} | sells to ${i.markets.join("/")} | certs ${i.certifications.join("+") || "none"} | geolocation ${i.geolocationOnFile ? "on file" : "MISSING"} | ${i.qtyOnHand} ${i.unit}`,
    )
    .join("\n");
}

async function assess(batch, items) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Today is ${today}. You monitor trade news for Binh Duong Wood Co., a Vietnamese wood-products and furniture manufacturer and exporter.

STOCK (one item per line):
${catalog(items)}

ARTICLES:
${batch.map((a, n) => `[${n}] ${a.title}${a.publisher ? ` (${a.publisher})` : ""} — ${a.publishedAt?.slice(0, 10) ?? "undated"}\n${a.snippet}`).join("\n\n")}

For every article return one assessment with its index. Be strict: most articles are NOT relevant, and a false alarm costs the owner time.
- relevant=true only when the article is directly about wood, timber, plywood, panels, flooring, furniture, cabinets, wood pellets or forest-risk rules for wood, OR about a trade measure (tariff, duty, anti-dumping, quota, ban, certification or due-diligence rule) that covers these goods or this company's markets/origins.
- NOT relevant: exchange rates, fuel or energy prices, interest rates, stock markets, property, general economic data, politics, and other commodities (cocoa, coffee, rubber tyres, critical minerals) — even if they mention EUDR or "supply chains" in passing.
- affected: only SKUs with a specific, explainable link (matching product type/HS code, species, timber origin, supplier country, destination market, certification, or missing geolocation for EU rules). Do not list every item in a category by default. For EU deforestation rules, items sold to the EU with geolocation MISSING come first.
- If several articles report the same event, mark the clearest one relevant and set sameAs on the others to that article's index.
- Base everything on the article text only. Do not invent rates, dates or legal details; if the article is vague, say what to verify and use direction "watch".
- severity: high = likely cost/market-access change within ~90 days for items in stock; medium = material but uncertain or later; low = worth knowing.`;
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
      maxOutputTokens: 16384,
      thinkingConfig: { thinkingBudget: 2048 },
    },
  });
  return JSON.parse(res.text || "{}").assessments ?? [];
}

export async function runScan({ trigger = "manual", lookbackDays } = {}) {
  const scanRef = scans.doc();
  const startedAt = new Date().toISOString();
  await scanRef.set({ startedAt, trigger, status: "running", model: MODEL });

  try {
    const [srcs, items, previous] = await Promise.all([
      list(sources.where("enabled", "==", true)),
      list(inventory),
      scans.where("status", "==", "done").limit(1).get(),
    ]);
    const lookback = lookbackDays ?? (previous.empty ? FIRST_RUN_LOOKBACK_DAYS : LOOKBACK_DAYS);
    const since = Date.now() - lookback * 86_400_000;

    // 1. Fetch every enabled source in parallel.
    const fetched = await Promise.allSettled(srcs.map((s) => fetchFeed(s.url)));
    const sourceStatus = [];
    const candidates = new Map();
    fetched.forEach((r, n) => {
      const s = srcs[n];
      const ok = r.status === "fulfilled";
      sourceStatus.push({ id: s.id, name: s.name, ok, count: ok ? r.value.length : 0, error: ok ? null : String(r.reason?.message || r.reason) });
      if (!ok) return;
      for (const a of r.value) {
        if (a.publishedAt && Date.parse(a.publishedAt) < since) continue;
        const id = hash(a.url);
        if (!candidates.has(id)) candidates.set(id, { ...a, id, sourceId: s.id, sourceName: s.name });
      }
    });

    // 2. Skip articles analysed in earlier scans.
    const ids = [...candidates.keys()];
    const seen = new Set();
    for (let i = 0; i < ids.length; i += 100) {
      const snaps = await db.getAll(...ids.slice(i, i + 100).map((id) => articles.doc(id)));
      snaps.forEach((d) => d.exists && seen.add(d.id));
    }
    const fresh = [...candidates.values()]
      .filter((a) => !seen.has(a.id))
      .sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""))
      .slice(0, MAX_NEW_ARTICLES);

    // 3. Ask Gemini, in batches, which stock each article touches.
    const bySku = new Map(items.map((i) => [i.sku, i]));
    const found = [];
    const analysed = [];
    for (let i = 0; i < fresh.length; i += BATCH) {
      const batch = fresh.slice(i, i + BATCH);
      let results;
      try {
        results = await assess(batch, items);
      } catch (e) {
        console.error("Gemini batch failed:", e);
        continue; // leave these articles unrecorded so the next scan retries them
      }
      const byIndex = new Map(results.map((r) => [r.index, r]));
      batch.forEach((a, n) => {
        const r = byIndex.get(n);
        if (!r) return;
        const affected = (r.affected || [])
          .filter((x) => bySku.has(x.sku))
          .map((x) => {
            const it = bySku.get(x.sku);
            return { sku: x.sku, name: it.name, reason: x.reason, stockValueUsd: Math.round(it.qtyOnHand * it.unitCostUsd) };
          });
        const duplicate = Number.isInteger(r.sameAs) && r.sameAs !== n;
        const relevant = Boolean(r.relevant && affected.length && !duplicate);
        analysed.push({ ...a, relevant });
        if (relevant)
          found.push({
            articleId: a.id,
            title: a.title,
            url: a.url,
            publisher: a.publisher || a.sourceName,
            sourceId: a.sourceId,
            sourceName: a.sourceName,
            publishedAt: a.publishedAt,
            severity: r.severity || "low",
            direction: r.direction || "watch",
            headline: r.headline || a.title,
            why: r.why || "",
            action: r.action || "",
            affected,
            stockValueUsd: affected.reduce((s, x) => s + x.stockValueUsd, 0),
            scanId: scanRef.id,
            createdAt: new Date().toISOString(),
            status: "open",
          });
      });
    }

    // 4. Persist articles, impacts, source health and the scan record.
    const writes = [
      ...analysed.map(({ id, ...a }) => [articles.doc(id), { ...a, analysedAt: new Date().toISOString(), scanId: scanRef.id }]),
      ...found.map((f) => [impacts.doc(f.articleId), f]),
    ];
    for (let i = 0; i < writes.length; i += 400) {
      const b = db.batch();
      writes.slice(i, i + 400).forEach(([ref, data]) => b.set(ref, data));
      await b.commit();
    }
    // 5. Make the new articles and alerts searchable by the assistant.
    let indexed = null;
    try {
      indexed = await indexDocs([...analysed.map(toDoc.article), ...found.map(toDoc.alert)]);
    } catch (e) {
      console.error("Indexing failed:", e);
    }
    const now = new Date().toISOString();
    await Promise.all(
      sourceStatus.map((s) => sources.doc(s.id).update({ lastFetchedAt: now, lastOk: s.ok, lastError: s.error, lastCount: s.count })),
    );
    const summary = {
      status: "done",
      finishedAt: now,
      lookbackDays: lookback,
      sources: sourceStatus,
      articlesFetched: candidates.size,
      articlesAnalysed: analysed.length,
      impactsFound: found.length,
      indexed: indexed?.embedded ?? null,
    };
    await scanRef.update(summary);
    return { id: scanRef.id, startedAt, ...summary };
  } catch (e) {
    await scanRef.update({ status: "failed", finishedAt: new Date().toISOString(), error: String(e.message || e) });
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv.find((a) => a.startsWith("--lookback="));
  const result = await runScan({ trigger: "cli", lookbackDays: arg ? Number(arg.split("=")[1]) : undefined });
  console.log(JSON.stringify(result, null, 2));
}
