// Hybrid retrieval: the vector index finds candidates by meaning, then BM25 over
// those candidates rewards exact terms that embeddings blur, such as HS codes
// (4412.33), SKUs (PLY-103) and rule names (EUDR, CBAM). Each hit keeps its
// cosine `score` and gains a `lexical` score in [0, 1]; results are ordered by
// score + LEXICAL_WEIGHT × lexical.

export const LEXICAL_WEIGHT = 0.15;
const K1 = 1.2;
const B = 0.75;
// "us" is not a stop word here: it is the US market.
const STOP = new Set(
  "the a an and or of to in on for with by from at as is are was were be been it its this that these those what which who how why when where do does did we our you your i my me any all have has had about into there their they them can could would should will much many more most some not if than then so".split(" "),
);

/** Lower-case terms; codes are kept whole and split ("4412.33" -> 4412.33, 4412, 33), plurals singular. */
export function terms(text) {
  const out = [];
  for (const token of String(text ?? "").toLowerCase().match(/[a-z0-9]+(?:[.\-/][a-z0-9]+)*/g) || []) {
    const parts = token.split(/[.\-/]/);
    for (const word of parts.length > 1 ? [token, ...parts] : [token]) {
      const t = word.length > 3 && /^[a-z]+s$/.test(word) && !word.endsWith("ss") ? word.slice(0, -1) : word;
      if (t.length >= 2 && !STOP.has(t)) out.push(t);
    }
  }
  return out;
}

/** BM25 of the query against each document (arrays of terms), with IDF taken over these documents. Scores are in [0, 1]. */
export function bm25(queryTerms, docs) {
  const n = docs.length;
  if (!n) return [];
  const avgLength = docs.reduce((s, d) => s + d.length, 0) / n || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const idf = (count) => Math.log(1 + (n - count + 0.5) / (count + 0.5));
  const query = [...new Set(queryTerms)];
  // Every query term in exactly one document, at saturation.
  const best = query.length * idf(1) * (K1 + 1);
  return docs.map((d) => {
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of query) {
      const f = tf.get(t);
      if (f) score += (idf(df.get(t)) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / avgLength));
    }
    return best ? Math.min(1, score / best) : 0;
  });
}

/** Reorders vector hits ({ score, title, text }) by cosine plus weighted BM25 and keeps the best `limit`. */
export function rerank(query, hits, limit) {
  const lexical = bm25(terms(query), hits.map((h) => terms(`${h.title} ${h.text}`)));
  return hits
    .map((h, i) => ({ ...h, lexical: Math.round(lexical[i] * 1000) / 1000 }))
    .sort((a, b) => b.score + LEXICAL_WEIGHT * b.lexical - (a.score + LEXICAL_WEIGHT * a.lexical))
    .slice(0, limit);
}
