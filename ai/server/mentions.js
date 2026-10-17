// What a news article names, for the backend's knowledge graph walk (backend
// services/knowledge_graph.py): from these it finds the company's orders through suppliers'
// sourcing and the material chain. Gemini reads them from the article; code keeps only
// well-formed values, so a model slip or text planted in an article can't add anything else.
// The backend matches materials to its own list and ignores the rest.

const MAX_PER_KIND = 8;
const MATERIAL = /^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,59}$/u; // "acacia logs", "bạch đàn"
const HS_CODE = /^\d{4}(\.?\d{2}){0,3}$/; // "4403", "4412.33", "440349"
const COUNTRY = /^[A-Z]{2}$/; // ISO 3166 alpha-2
const MARKET = /^[A-Z]{2}$/; // "EU", "US", "UK"

function keep(values, pattern, normalise) {
  if (!Array.isArray(values)) return [];
  const kept = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const clean = normalise(value.trim());
    if (pattern.test(clean) && !kept.includes(clean)) kept.push(clean);
    if (kept.length === MAX_PER_KIND) break;
  }
  return kept;
}

/** The article's mentions as stored on an alert; every list is present, possibly empty. */
export function cleanMentions(raw) {
  const m = raw && typeof raw === "object" ? raw : {};
  return {
    materials: keep(m.materials, MATERIAL, (s) => s.toLowerCase().replace(/\s+/g, " ")),
    hsCodes: keep(m.hsCodes, HS_CODE, (s) => s.replace(/\s+/g, "")),
    originCountries: keep(m.originCountries, COUNTRY, (s) => s.toUpperCase()),
    markets: keep(m.markets, MARKET, (s) => s.toUpperCase()),
  };
}
