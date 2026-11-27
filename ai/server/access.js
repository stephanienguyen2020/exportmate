// Who sees what. Pure functions, so they can be tested without Firestore.
//
// News sources: built-in sources (and custom ones added before sources had owners) are
// shared by every workspace. A company can switch a shared source off for itself only;
// that hides its articles and alerts for that company and nobody else. A custom source
// belongs to the company that added it: only that company sees it and what it brought
// in, and only that company's owners and editors can switch it off or remove it.
//
// News alerts and stock items are about one company's goods and carry its companyId (the
// backend's news scan and GET /news-goods): only that company sees them. The browser demo is the
// demo company (DEMO_COMPANY_ID, no account), whose goods are the sample stock (seed.js). The
// backend applies the same rules (services/news_alerts.py, news_sources.py).
//
// `access` is { companyId, disabled, skipOld }: the caller's company (the demo company signed
// out), the shared sources it switched off, and false when it switched the age rule off.
//
// The age rule: by default the scan (backend services/news_scan.py) skips articles published
// more than MAX_AGE_DAYS before it (SCAN_MAX_AGE_DAYS, the same on both; 0 removes the rule). A company can switch it off for itself;
// the scan then also reads old articles from the sources that company reads, and only that
// company sees what they raise. Undated articles have no known age and are always read.

// The backend's DEMO_COMPANY_ID must match.
export const DEMO_COMPANY_ID = process.env.DEMO_COMPANY_ID || "sample";
export const ANONYMOUS = Object.freeze({ companyId: DEMO_COMPANY_ID, disabled: [] });

const envDays = process.env.SCAN_MAX_AGE_DAYS;
export const MAX_AGE_DAYS = /^\d+$/.test(envDays || "") ? Number(envDays) : 365;

/** Whether the age rule applies to this caller (on unless their company switched it off). */
export const skipsOld = (access, maxAgeDays = MAX_AGE_DAYS) => maxAgeDays > 0 && access.skipOld !== false;

export const isShared = (source) => Boolean(source.builtIn) || !source.companyId;

export const sourceVisible = (source, access) => isShared(source) || source.companyId === access.companyId;

export const sourceEnabled = (source, access) =>
  Boolean(source.enabled) && !(isShared(source) && access.disabled.includes(source.id));

/** The sources a caller sees, with `enabled` as it applies to them and no owner ids. */
export function presentSources(sources, access) {
  return sources
    .filter((s) => sourceVisible(s, access))
    .map(({ companyId, ...s }) => ({ ...s, enabled: sourceEnabled({ ...s, companyId }, access), shared: isShared({ ...s, companyId }) }));
}

// The source ids an impact, article or index document came from. Older records carry one
// `sourceId`; index documents for a source carry its id as `refId`.
function sourceIdsOf(item) {
  if (Array.isArray(item.sourceIds) && item.sourceIds.length) return item.sourceIds;
  if (item.sourceId) return [item.sourceId];
  if (item.type === "source" && item.refId) return [item.refId];
  return [];
}

/** Whether a caller may see an alert or stock item for whose goods it is; other records pass. */
export function goodsVisible(item, access) {
  // Stored alerts carry no type; index hits do.
  const aboutGoods = item.type ? item.type === "alert" || item.type === "item" : Array.isArray(item.affected);
  if (!aboutGoods) return true;
  return item.companyId === access.companyId;
}

/**
 * Whether a caller may see an impact, article or index hit. An alert or stock item must be about
 * the caller's goods (goodsVisible) and pass the caller's age rule; then it is visible when any
 * source it came from is visible and switched on for the caller. Records whose sources were deleted fall back
 * to the owner stored with them (`sourceCompanyIds`); records from before owners existed are shared.
 */
export function itemVisible(item, sourcesById, access, maxAgeDays = MAX_AGE_DAYS) {
  if (!goodsVisible(item, access)) return false;
  // Older than the age rule when scanned: read only for a company that switched the rule off.
  // Records scanned before the rule have no ageDays.
  if (skipsOld(access, maxAgeDays) && item.ageDays > maxAgeDays) return false;
  const ids = sourceIdsOf(item);
  if (!ids.length) return true; // stock items, guides
  const known = ids.map((id) => sourcesById.get(id)).filter(Boolean);
  if (known.length) return known.some((s) => sourceVisible(s, access) && sourceEnabled(s, access));
  // A null owner is a shared source.
  const owners = item.sourceCompanyIds || [];
  return !owners.length || owners.some((owner) => !owner || owner === access.companyId);
}

export const visibleItems = (items, sources, access, maxAgeDays = MAX_AGE_DAYS) => {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return items.filter((item) => itemVisible(item, byId, access, maxAgeDays));
};

/**
 * A scan record as a caller sees it: `impactsFound` is the alerts it raised for the caller's
 * goods; other companies' counts stay on the server.
 */
export function presentScan(scan, access) {
  if (!scan) return scan;
  const { companyImpacts, ...shown } = scan;
  // Another company's own sources are neither named nor counted. Each carries its owner
  // (null when shared); scans recorded before that show every source.
  if (Array.isArray(shown.sources))
    shown.sources = shown.sources.filter((s) => sourceVisible(s, access)).map(({ companyId, ...s }) => s);
  return { ...shown, impactsFound: companyImpacts?.[access.companyId] ?? 0 };
}

// The model's raw reasoning stays in the stored audit for reviewers; the app shows step
// summaries only.
export const publicStep = ({ thought, ...step }) => step;
export const publicAudit = (audit) => ({ ...audit, steps: (audit.steps || []).map(publicStep) });
