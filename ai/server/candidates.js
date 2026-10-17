// Which fetched articles a scan considers, and how a failed Gemini call is reported. Pure, so
// the age rule can be tested without Firestore or feeds.
import crypto from "node:crypto";
import { ageDays, isShared, readsOld } from "./access.js";

export const articleId = (url) => crypto.createHash("sha1").update(url).digest("hex").slice(0, 20);

/**
 * The articles from every source that fetched (`fetched[n]` is Promise.allSettled's result for
 * `srcs[n]`), one per URL, with every source that carried it and its owner (null when shared),
 * so a company only sees articles and alerts from sources it can see (access.js). An article
 * published more than `maxAgeDays` before `at` is skipped, unless the source is read by a company
 * that switched the age rule off (`oldReaders`); `tooOld` counts the ones skipped.
 */
export function collectCandidates(fetched, srcs, { at, maxAgeDays, oldReaders = [] }) {
  const candidates = new Map();
  const skipped = new Set();
  fetched.forEach((r, n) => {
    if (r.status !== "fulfilled") return;
    const s = srcs[n];
    const owner = isShared(s) ? null : s.companyId;
    const skipOld = maxAgeDays > 0 && !readsOld(s, oldReaders);
    for (const a of r.value) {
      const id = articleId(a.url);
      const age = ageDays(a.publishedAt, at);
      if (skipOld && age > maxAgeDays) {
        skipped.add(id);
        continue;
      }
      const known = candidates.get(id);
      if (!known) candidates.set(id, { ...a, id, ageDays: age, sourceId: s.id, sourceName: s.name, sourceIds: [s.id], sourceCompanyIds: [owner] });
      else if (!known.sourceIds.includes(s.id)) {
        known.sourceIds.push(s.id);
        known.sourceCompanyIds.push(owner);
      }
    }
  });
  return { candidates, tooOld: [...skipped].filter((id) => !candidates.has(id)).length };
}

/**
 * What a company's scan reads: this scan's new articles it can see (`visible`, access.js) and,
 * when `backlog` is given (its first scan), up to `max` stored ones it can see from that list
 * (newest first). The cap counts only articles the company can see, so another company's own
 * busy feed can't fill it and cut the read-back short.
 */
export function companyReading(fresh, visible, backlog, max) {
  const reading = fresh.filter(visible);
  if (!backlog) return reading;
  const freshIds = new Set(fresh.map((a) => a.id));
  return [...reading, ...backlog.filter((a) => !freshIds.has(a.id) && visible(a)).slice(0, max)];
}

/** A Gemini error as a sentence: the API's message, not the JSON it arrives wrapped in. */
export function errorText(e) {
  const text = String(e?.message || e);
  try {
    return JSON.parse(text).error?.message || text;
  } catch {
    return text;
  }
}
