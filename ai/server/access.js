// Who sees what. Pure functions, so they can be tested without Firestore.
//
// News sources: built-in sources (and custom ones added before sources had owners) are
// shared by every workspace. A company can switch a shared source off for itself only;
// that hides its articles and alerts for that company and nobody else. A custom source
// belongs to the company that added it: only that company sees it and what it brought
// in, and only that company's owners and editors can switch it off or remove it.
//
// News alerts and stock items are about someone's goods: a company's own (they carry its
// companyId; scan.js, goods.js) or the sample stock, which only the browser demo sees.
//
// `access` is { companyId, disabled, skipOld }: the caller's company (null for the demo), the
// shared sources that company switched off, and false when it switched the age rule off.
//
// The age rule: by default a scan skips articles published more than MAX_AGE_DAYS before it
// (SCAN_MAX_AGE_DAYS; 0 removes the rule for everyone). A company can switch it off for itself;
// the scan then also reads old articles from the sources that company reads, and only that
// company sees what they raise. Undated articles have no known age and are always read.

export const ANONYMOUS = Object.freeze({ companyId: null, disabled: [] });

const envDays = process.env.SCAN_MAX_AGE_DAYS;
export const MAX_AGE_DAYS = /^\d+$/.test(envDays || "") ? Number(envDays) : 365;

/** Whether the age rule applies to this caller (on unless their company switched it off). */
export const skipsOld = (access, maxAgeDays = MAX_AGE_DAYS) => maxAgeDays > 0 && access.skipOld !== false;

/** The age rule as a caller sees it, for News watch: null when no rule is configured. */
export const scanRules = (access, maxAgeDays = MAX_AGE_DAYS) =>
  maxAgeDays > 0 ? { maxAgeDays, skipOld: skipsOld(access, maxAgeDays) } : null;

/** Whole days between an article's publication and `at` (a scan's start), or null when undated. */
export function ageDays(publishedAt, at) {
  const published = Date.parse(publishedAt || "");
  return Number.isNaN(published) ? null : Math.max(0, Math.floor((at - published) / 86_400_000));
}

export const isShared = (source) => Boolean(source.builtIn) || !source.companyId;

export const sourceVisible = (source, access) => isShared(source) || (Boolean(access.companyId) && source.companyId === access.companyId);

export const sourceEnabled = (source, access) =>
  Boolean(source.enabled) && !(isShared(source) && access.disabled.includes(source.id));

/**
 * Whether a scan reads old articles from `source`: some company that switched the age rule off
 * (`oldReaders`, each an access) can see the source and has it switched on.
 */
export const readsOld = (source, oldReaders) => oldReaders.some((access) => sourceVisible(source, access) && sourceEnabled(source, access));

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
  return item.companyId ? item.companyId === access.companyId : !access.companyId;
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
 * goods (the sample stock's in the demo, the company's own otherwise); other companies' counts
 * stay on the server.
 */
export function presentScan(scan, access) {
  if (!scan) return scan;
  const { companyImpacts, ...shown } = scan;
  // Another company's own sources are neither named nor counted. Each carries its owner
  // (null when shared); scans recorded before that show every source.
  if (Array.isArray(shown.sources))
    shown.sources = shown.sources.filter((s) => sourceVisible(s, access)).map(({ companyId, ...s }) => s);
  return access.companyId ? { ...shown, impactsFound: companyImpacts?.[access.companyId] ?? 0 } : shown;
}

// Audits: an anonymous (demo) chat's audit is readable with its session id, as before.
// One made in a company workspace also needs a token from that company.
export const auditVisible = (audit, access) => !audit.companyId || audit.companyId === access.companyId;

// The model's raw reasoning stays in the stored audit for reviewers; the app shows step
// summaries only (backend/docs/REQUIREMENTS.md 4.6).
export const publicStep = ({ thought, ...step }) => step;
export const publicAudit = (audit) => ({ ...audit, steps: (audit.steps || []).map(publicStep) });
