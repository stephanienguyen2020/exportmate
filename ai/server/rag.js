// Vector store for retrieval-augmented chat: Firestore vector search over
// embeddings from Vertex AI. Every searchable record (stock item, news article,
// news alert, source, help guide) becomes one document in the `kb` collection.
// `npm run index` rebuilds the whole index; scans and seeding index incrementally.
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { FieldValue } from "@google-cloud/firestore";
import { GoogleGenAI } from "@google/genai";
import { db, PROJECT, inventory, sources, articles, impacts, list } from "./db.js";
import { GUIDES } from "./seed/guides.js";
import { rerank } from "./rerank.js";
import { isShared } from "./access.js";

export const EMBED_MODEL = process.env.EMBED_MODEL || "gemini-embedding-001";
export const DIMENSIONS = 768; // must match the Firestore vector index
export const kb = db.collection("kb");
export const TYPES = ["item", "alert", "article", "source", "guide"];

const ai = new GoogleGenAI({
  vertexai: true,
  project: PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION || "global",
});
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex");
const day = (iso) => (iso ? iso.slice(0, 10) : "undated");

export async function embed(texts, taskType) {
  const out = [];
  for (let i = 0; i < texts.length; i += 50) {
    const res = await ai.models.embedContent({
      model: EMBED_MODEL,
      contents: texts.slice(i, i + 50),
      config: { taskType, outputDimensionality: DIMENSIONS },
    });
    out.push(...res.embeddings.map((e) => e.values));
  }
  return out;
}

// Query embeddings already computed on this instance, so a repeated search isn't embedded again.
const queryVectors = new Map();
async function embedQuery(query) {
  if (queryVectors.has(query)) return queryVectors.get(query);
  const [vector] = await embed([query], "RETRIEVAL_QUERY");
  if (queryVectors.size >= 500) queryVectors.delete(queryVectors.keys().next().value); // oldest first
  queryVectors.set(query, vector);
  return vector;
}

// Which sources a record came from and who owns them, so searches only return what the
// asking company may see (access.js). Records from before sources had owners have neither.
const origin = (r) => ({
  ...(r.sourceIds ? { sourceIds: r.sourceIds } : r.sourceId ? { sourceIds: [r.sourceId] } : {}),
  ...(r.sourceCompanyIds ? { sourceCompanyIds: r.sourceCompanyIds } : {}),
});

// One searchable document per record. `text` is what gets embedded.
export const toDoc = {
  item: (i) => ({
    id: `item:${i.sku}`,
    type: "item",
    refId: i.sku,
    title: `${i.sku} · ${i.name}`,
    url: "#/workspace/news",
    text:
      `Stock item ${i.sku}: ${i.name}. Category ${i.category}, HS code ${i.hsCode}. ` +
      `Made of ${i.species} from ${i.timberOrigin}; supplier ${i.supplier}. Sold to ${i.markets.join(", ")}. ` +
      `Certifications: ${i.certifications.join(", ") || "none"}. Geolocation data ${i.geolocationOnFile ? "on file" : "missing"}. ` +
      `${i.qtyOnHand} ${i.unit} on hand at ${i.warehouse}, unit cost USD ${i.unitCostUsd}, stock value USD ${Math.round(i.qtyOnHand * i.unitCostUsd)}.`,
  }),
  alert: (a) => ({
    id: `alert:${a.articleId}`,
    type: "alert",
    refId: a.articleId,
    ...origin(a),
    title: a.headline,
    url: a.url,
    publishedAt: a.publishedAt,
    source: a.publisher,
    text:
      `News alert, ${a.severity} severity, ${a.direction}: ${a.headline}. ${a.why} ` +
      `Affected stock: ${a.affected.map((x) => `${x.sku} ${x.name} (${x.reason})`).join("; ")}. ` +
      `Stock value exposed USD ${a.stockValueUsd}. Next step: ${a.action} Source article: "${a.title}", ${a.publisher}, ${day(a.publishedAt)}.`,
  }),
  article: (a) => ({
    id: `article:${a.id}`,
    type: "article",
    refId: a.id,
    ...origin(a),
    title: a.title,
    url: a.url,
    publishedAt: a.publishedAt,
    source: a.publisher || a.sourceName,
    text: `${a.title}. Published ${day(a.publishedAt)} by ${a.publisher || a.sourceName} (via ${a.sourceName}). ${a.snippet}`,
  }),
  source: (s) => ({
    id: `source:${s.id}`,
    type: "source",
    refId: s.id,
    sourceIds: [s.id],
    sourceCompanyIds: [isShared(s) ? null : s.companyId],
    title: s.name,
    url: s.url,
    text: `News source "${s.name}" (${s.kind}), ${s.enabled ? "enabled" : "disabled"}, feed ${s.url}. ${s.builtIn ? "Built-in source." : "Custom source added by the user."}`,
  }),
  guide: (g) => ({ id: `guide:${g.id}`, type: "guide", refId: g.id, title: g.title, url: g.url, text: `${g.title}. ${g.text}` }),
};

/** Upserts documents, embedding only those whose text changed. */
export async function indexDocs(docs) {
  if (!docs.length) return { embedded: 0, unchanged: 0 };
  const existing = new Map();
  for (let i = 0; i < docs.length; i += 100) {
    const snaps = await db.getAll(...docs.slice(i, i + 100).map((d) => kb.doc(d.id)));
    snaps.forEach((s) => s.exists && existing.set(s.id, s.get("textHash")));
  }
  const changed = docs.filter((d) => existing.get(d.id) !== hash(d.text));
  const vectors = await embed(changed.map((d) => d.text), "RETRIEVAL_DOCUMENT");
  for (let i = 0; i < changed.length; i += 400) {
    const batch = db.batch();
    changed.slice(i, i + 400).forEach(({ id, ...d }, n) =>
      batch.set(kb.doc(id), {
        ...d,
        textHash: hash(d.text),
        embedding: FieldValue.vector(vectors[i + n]),
        embeddingModel: EMBED_MODEL,
        indexedAt: new Date().toISOString(),
      }),
    );
    await batch.commit();
  }
  return { embedded: changed.length, unchanged: docs.length - changed.length };
}

/** Rebuilds the index from every collection and removes stale documents. */
export async function reindexAll() {
  const [items, srcs, arts, alerts] = await Promise.all([list(inventory), list(sources), list(articles), list(impacts)]);
  const docs = [
    ...items.map(toDoc.item),
    ...srcs.map(toDoc.source),
    ...arts.map(toDoc.article),
    ...alerts.map((a) => toDoc.alert({ ...a, articleId: a.articleId || a.id })),
    ...GUIDES.map(toDoc.guide),
  ];
  const result = await indexDocs(docs);
  const keep = new Set(docs.map((d) => d.id));
  const stale = (await kb.select().get()).docs.filter((d) => !keep.has(d.id));
  for (let i = 0; i < stale.length; i += 400) {
    const batch = db.batch();
    stale.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  return { documents: docs.length, ...result, removed: stale.length };
}

/**
 * Hybrid search: the nearest documents by embedding (three times as many as asked
 * for), reranked with BM25 so exact codes and names count (rerank.js). Optional
 * `types` pre-filter uses the (type, embedding) index.
 */
export async function search(query, { types, limit = 6, filter = () => true } = {}) {
  const vector = await embedQuery(query);
  const pool = Math.min(limit * 3, 30);
  const nearest = (q) =>
    q
      .findNearest({ vectorField: "embedding", queryVector: vector, limit: pool, distanceMeasure: "COSINE", distanceResultField: "distance" })
      .get();
  const wanted = (types || []).filter((t) => TYPES.includes(t));
  const snaps = wanted.length ? await Promise.all(wanted.map((t) => nearest(kb.where("type", "==", t)))) : [await nearest(kb)];
  const hits = snaps
    .flatMap((s) => s.docs)
    .map((d) => {
      const { embedding, textHash, ...data } = d.data();
      return { ...data, id: d.id, score: Math.round((1 - data.distance) * 1000) / 1000 };
    })
    .filter(filter); // e.g. drop articles from another company's sources
  return rerank(query, hits, limit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const query = process.argv.slice(2).join(" ");
  if (query) {
    for (const r of await search(query, { limit: 6 })) console.log(r.score, r.lexical, r.type.padEnd(7), r.title.slice(0, 90));
  } else {
    console.log(await reindexAll());
  }
}
