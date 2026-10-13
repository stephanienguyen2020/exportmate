// Who sees what. Pure functions, so they can be tested without Firestore.
//
// News sources: built-in sources (and custom ones added before sources had owners) are
// shared by every workspace. A company can switch a shared source off for itself only;
// that hides its articles and alerts for that company and nobody else. A custom source
// belongs to the company that added it: only that company sees it and what it brought
// in, and only that company's owners and editors can switch it off or remove it.
//
// `access` is { companyId, disabled }: the caller's company (null for the demo) and the
// shared sources that company switched off.

export const ANONYMOUS = Object.freeze({ companyId: null, disabled: [] });

export const isShared = (source) => Boolean(source.builtIn) || !source.companyId;

export const sourceVisible = (source, access) => isShared(source) || (Boolean(access.companyId) && source.companyId === access.companyId);

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

/**
 * Whether a caller may see an impact, article or index hit. Visible when any source it came
 * from is visible and switched on for the caller. Records whose sources were deleted fall back
 * to the owner stored with them (`sourceCompanyIds`); records from before owners existed are shared.
 */
export function itemVisible(item, sourcesById, access) {
  const ids = sourceIdsOf(item);
  if (!ids.length) return true; // stock items, guides
  const known = ids.map((id) => sourcesById.get(id)).filter(Boolean);
  if (known.length) return known.some((s) => sourceVisible(s, access) && sourceEnabled(s, access));
  // A null owner is a shared source.
  const owners = item.sourceCompanyIds || [];
  return !owners.length || owners.some((owner) => !owner || owner === access.companyId);
}

export const visibleItems = (items, sources, access) => {
  const byId = new Map(sources.map((s) => [s.id, s]));
  return items.filter((item) => itemVisible(item, byId, access));
};

// Audits: an anonymous (demo) chat's audit is readable with its session id, as before.
// One made in a company workspace also needs a token from that company.
export const auditVisible = (audit, access) => !audit.companyId || audit.companyId === access.companyId;

// The model's raw reasoning stays in the stored audit for reviewers; the app shows step
// summaries only (backend/REQUIREMENTS.md 4.6).
export const publicStep = ({ thought, ...step }) => step;
export const publicAudit = (audit) => ({ ...audit, steps: (audit.steps || []).map(publicStep) });
