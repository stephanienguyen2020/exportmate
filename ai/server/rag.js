// Retrieval for the assistant on Agent Platform RAG Engine. Every searchable record (stock
// item, news article, news alert, source, help guide) becomes one text file in Cloud Storage
// (RAG_BUCKET), imported into the RAG corpus for its type (exportmate-kb-<type>), which embeds it
// with RAG_EMBED_MODEL and retrieves by meaning. Firestore `rag_files` keeps each record's
// metadata (title, url, date, sources) and which RAG file holds it, so results can be checked
// against who may see them (access.js) before any agent reads them. `npm run index` rebuilds
// everything; scans, seeding and source changes index incrementally.
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { GoogleAuth } from "google-auth-library";
import { db, PROJECT, inventory, sources, articles, impacts, list } from "./db.js";
import { GUIDES } from "./seed/guides.js";
import { rerank } from "./rerank.js";
import { isShared } from "./access.js";

export const EMBED_MODEL = process.env.RAG_EMBED_MODEL || "text-multilingual-embedding-002";
const LOCATION = process.env.RAG_LOCATION || "asia-southeast1";
const BUCKET = process.env.RAG_BUCKET || `${PROJECT}-kb`;
export const ragFiles = db.collection("rag_files");
export const TYPES = ["item", "alert", "article", "source", "guide"];

const hash = (s) => crypto.createHash("sha1").update(s).digest("hex");
const day = (iso) => (iso ? iso.slice(0, 10) : "undated");

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
async function call(method, url, data, headers) {
  const client = await auth.getClient();
  return (await client.request({ url, method, data, headers })).data;
}
const parent = `projects/${PROJECT}/locations/${LOCATION}`;
const api = (path) => `https://${LOCATION}-aiplatform.googleapis.com/v1/${path}`;
async function done(op) {
  while (!op.done) {
    await new Promise((r) => setTimeout(r, 3000));
    op = await call("GET", api(op.name));
  }
  if (op.error) throw new Error(`RAG Engine: ${op.error.message || JSON.stringify(op.error)}`);
  return op.response ?? {};
}

// One corpus per document type, found by display name (created on first index).
let corpusNames = null;
async function corpora({ create = false } = {}) {
  if (!corpusNames || (create && Object.keys(corpusNames).length < TYPES.length)) {
    const found = {};
    let page = "";
    do {
      const res = await call("GET", api(`${parent}/ragCorpora?pageSize=100${page ? `&pageToken=${page}` : ""}`));
      for (const c of res.ragCorpora || []) {
        const type = c.displayName?.match(/^exportmate-kb-(\w+)$/)?.[1];
        if (TYPES.includes(type)) found[type] = c.name;
      }
      page = res.nextPageToken;
    } while (page);
    for (const type of create ? TYPES.filter((t) => !found[t]) : [])
      found[type] = (
        await done(
          await call("POST", api(`${parent}/ragCorpora`), {
            display_name: `exportmate-kb-${type}`,
            description: `ExportMate assistant search: ${type} documents`,
            vector_db_config: {
              rag_managed_db: {},
              rag_embedding_model_config: { vertex_prediction_endpoint: { endpoint: `${parent}/publishers/google/models/${EMBED_MODEL}` } },
            },
          }),
        )
      ).name;
    corpusNames = found;
  }
  return corpusNames;
}

// Cloud Storage objects for imported files (the JSON API, so no extra client library).
const object = (name) => `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}`;
const saveObject = (name, text) =>
  call("POST", `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`, text, {
    "Content-Type": "text/plain; charset=utf-8",
  });
const deleteObject = (name) => call("DELETE", object(name)).catch((e) => (e.response?.status === 404 ? null : Promise.reject(e)));
// A record id as a file name ("article:abc" → "article:abc.txt") and back.
const fileName = (id) => `${encodeURIComponent(id)}.txt`;
const idOf = (name) => decodeURIComponent(String(name).split("/").pop().replace(/\.txt$/, ""));

async function listFiles(corpus) {
  const files = [];
  let page = "";
  do {
    const res = await call("GET", api(`${corpus}/ragFiles?pageSize=100${page ? `&pageToken=${page}` : ""}`));
    files.push(...(res.ragFiles || []));
    page = res.nextPageToken;
  } while (page);
  return files;
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
      `Made of ${i.material} from ${i.materialOrigin}; supplier ${i.supplier}. Sold to ${i.markets.join(", ")}. ` +
      `Certifications: ${i.certifications.join(", ") || "none"}. Origin trace ${i.originTraced ? "on file" : "missing"}. ` +
      `${i.qtyOnHand} ${i.unit} on hand at ${i.warehouse}, unit cost USD ${i.unitCostUsd}, stock value USD ${Math.round(i.qtyOnHand * i.unitCostUsd)}.`,
  }),
  // A company's alert (scan.js) has an id of its own and its companyId: only it sees the alert.
  alert: (a) => ({
    id: `alert:${a.impactId ?? a.articleId}`,
    type: "alert",
    refId: a.impactId ?? a.articleId,
    ...origin(a),
    ...(a.companyId ? { companyId: a.companyId } : {}),
    title: a.headline,
    url: a.url,
    publishedAt: a.publishedAt,
    source: a.publisher,
    text:
      `News alert, ${a.severity} severity, ${a.direction}: ${a.headline}. ${a.why} ` +
      `Affected ${a.companyId ? "goods" : "stock"}: ${a.affected.map((x) => `${x.sku} ${x.name} (${x.reason})`).join("; ")}. ` +
      `${Number.isFinite(a.stockValueUsd) ? `Stock value exposed USD ${a.stockValueUsd}. ` : ""}Next step: ${a.action} Source article: "${a.title}", ${a.publisher}, ${day(a.publishedAt)}.`,
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

/**
 * Upserts documents: only those whose text changed are written to Cloud Storage and imported,
 * one folder (one import) per type per call; the files they replace are then removed.
 */
export async function indexDocs(docs) {
  if (!docs.length) return { imported: 0, unchanged: 0 };
  const existing = new Map();
  for (let i = 0; i < docs.length; i += 100) {
    const snaps = await db.getAll(...docs.slice(i, i + 100).map((d) => ragFiles.doc(d.id)));
    snaps.forEach((s) => s.exists && existing.set(s.id, s.data()));
  }
  const changed = docs.filter((d) => existing.get(d.id)?.textHash !== hash(d.text));
  if (!changed.length) return { imported: 0, unchanged: docs.length };
  const names = await corpora({ create: true });
  const run = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  for (const type of TYPES) {
    const batch = changed.filter((d) => d.type === type);
    if (!batch.length) continue;
    const folder = `kb/${type}/${run}/`;
    for (let i = 0; i < batch.length; i += 20) await Promise.all(batch.slice(i, i + 20).map((d) => saveObject(folder + fileName(d.id), `${d.title}\n\n${d.text}`)));
    await done(
      await call("POST", api(`${names[type]}/ragFiles:import`), {
        import_rag_files_config: {
          gcs_source: { uris: [`gs://${BUCKET}/${folder}`] },
          // One record is one chunk: they are short, and a result should be a whole record.
          rag_file_transformation_config: { rag_file_chunking_config: { fixed_length_chunking: { chunk_size: 1024, chunk_overlap: 0 } } },
        },
      }),
    );
    // Which RAG file now holds each record (by its Cloud Storage path).
    const byUri = new Map((await listFiles(names[type])).flatMap((f) => (f.gcsSource?.uris || []).map((u) => [u, f.name])));
    for (let i = 0; i < batch.length; i += 400) {
      const writes = db.batch();
      batch.slice(i, i + 400).forEach(({ id, ...d }) => {
        const gcsPath = folder + fileName(id);
        writes.set(ragFiles.doc(id), { ...d, textHash: hash(d.text), ragFile: byUri.get(`gs://${BUCKET}/${gcsPath}`) || null, gcsPath, embeddingModel: EMBED_MODEL, indexedAt: new Date().toISOString() });
      });
      await writes.commit();
    }
    // The files these records replace.
    await removeFiles(batch.map((d) => existing.get(d.id)).filter(Boolean));
  }
  return { imported: changed.length, unchanged: docs.length - changed.length };
}

async function removeFiles(records) {
  for (let i = 0; i < records.length; i += 10)
    await Promise.all(
      records.slice(i, i + 10).flatMap((r) => [
        r.ragFile ? call("DELETE", api(r.ragFile)).catch((e) => (e.response?.status === 404 ? null : Promise.reject(e))) : null,
        r.gcsPath ? deleteObject(r.gcsPath) : null,
      ]),
    );
}

/** Removes records (e.g. a deleted news source) from search. */
export async function removeDocs(ids) {
  const snaps = ids.length ? await db.getAll(...ids.map((id) => ragFiles.doc(id))) : [];
  const records = snaps.filter((s) => s.exists);
  await removeFiles(records.map((s) => s.data()));
  await Promise.all(records.map((s) => s.ref.delete()));
  return records.length;
}

/** Rebuilds the index from every collection and removes stale documents. */
export async function reindexAll() {
  const [items, srcs, arts, alerts] = await Promise.all([list(inventory), list(sources), list(articles), list(impacts)]);
  const docs = [
    ...items.map(toDoc.item),
    ...srcs.map(toDoc.source),
    ...arts.map(toDoc.article),
    ...alerts.map((a) => toDoc.alert({ ...a, impactId: a.id, articleId: a.articleId || a.id })),
    ...GUIDES.map(toDoc.guide),
  ];
  const result = await indexDocs(docs);
  const keep = new Set(docs.map((d) => d.id));
  const stale = (await ragFiles.select().get()).docs.filter((d) => !keep.has(d.id)).map((d) => d.id);
  const removed = await removeDocs(stale);
  return { documents: docs.length, ...result, removed };
}

/**
 * Hybrid search: RAG Engine's nearest records for the requested types (three times as many as
 * asked for), checked by `filter` (e.g. another company's sources) and reranked with BM25 so
 * exact codes and names count (rerank.js).
 */
export async function search(query, { types, limit = 6, filter = () => true } = {}) {
  const names = await corpora();
  const wanted = (types || []).filter((t) => TYPES.includes(t));
  const corpusList = (wanted.length ? wanted : TYPES).map((t) => names[t]).filter(Boolean);
  if (!corpusList.length) return [];
  // retrieveContexts takes one corpus per call, so the types are searched in parallel.
  const results = await Promise.all(
    corpusList.map((rag_corpus) =>
      call("POST", api(`${parent}:retrieveContexts`), {
        vertex_rag_store: { rag_resources: [{ rag_corpus }] },
        query: { text: query, rag_retrieval_config: { top_k: Math.min(limit * 3, 30) } },
      }),
    ),
  );
  // Nearest first across the types; RAG Engine's managed index reports cosine distance.
  const contexts = results.flatMap((r) => r.contexts?.contexts || []).sort((a, b) => (a.score ?? 1) - (b.score ?? 1)).slice(0, Math.min(limit * 3, 30));
  const distance = new Map();
  for (const c of contexts) {
    const id = idOf(c.sourceUri || c.sourceDisplayName);
    if (!distance.has(id)) distance.set(id, c.score ?? 1);
  }
  const ids = [...distance.keys()];
  const snaps = ids.length ? await db.getAll(...ids.map((id) => ragFiles.doc(id))) : [];
  const hits = snaps
    .filter((s) => s.exists)
    .map((s) => {
      const { textHash, ragFile, gcsPath, embeddingModel, indexedAt, ...data } = s.data();
      return { ...data, id: s.id, score: Math.round((1 - distance.get(s.id)) * 1000) / 1000 };
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
