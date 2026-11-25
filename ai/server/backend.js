// The company backend (FastAPI): its origin, and its public reference data. This service never
// reads the backend's database; company data is read through the API with the user's own token
// (index.js, runtime.js).
export const BACKEND_URL = (process.env.BACKEND_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

// Order statuses as the backend's database names them (GET /api/v1/order-statuses, public, the
// same for every company), so answers word a status as the app's screens do. Kept for ten
// minutes; while the backend can't be read, a status is shown by its code.
const STATUSES_TTL_MS = 10 * 60_000;
let statuses = { at: 0, labels: null };

/** { code: label } for every order status; {} when the backend can't be read. */
export async function orderStatusLabels({ now = Date.now(), fetchImpl = fetch } = {}) {
  if (statuses.labels && now - statuses.at < STATUSES_TTL_MS) return statuses.labels;
  try {
    const res = await fetchImpl(`${BACKEND_URL}/api/v1/order-statuses`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!res.ok) return statuses.labels || {};
    const { data } = await res.json();
    statuses = { at: now, labels: Object.fromEntries(data.map((s) => [s.code, s.label])) };
    return statuses.labels;
  } catch {
    return statuses.labels || {};
  }
}

/** Forgets the kept statuses (tests). */
export function clearStatusLabels() {
  statuses = { at: 0, labels: null };
}
