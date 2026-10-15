// The signed-in company's orders as the query_orders tool shows them. They come from the
// company backend's GET /api/v1/trade-map (read with the user's own token): every order with
// its market's document checklist and the official text behind each line. Pure, so it is
// tested without the backend.

export const ORDER_STATUSES = ["exposed", "needs_data", "awaiting_analysis", "clear"];
// What the Orders page shows for each status (frontend/src/workspace/OrderTable.tsx).
const STATUS_LABELS = { exposed: "Action needed", needs_data: "Needs data", awaiting_analysis: "Awaiting analysis", clear: "In the clear" };
// Checklist lines that count as gaps (the backend's gapCount).
const GAPS = new Set(["missing", "mismatch"]);
const MAX_QUOTE = 300;

// "po 2291", "PO-2291" and "po2291" name the same order.
const orderKey = (id) => String(id).toUpperCase().replace(/[^A-Z0-9]/g, "");
const contains = (value, q) => String(value ?? "").toLowerCase().includes(q);

/** Orders matching every filter given: ids, query (text in id, product, supplier, destination or HS code) and status. */
export function matchOrders(mapOrders, { ids, query, status } = {}) {
  const wanted = ids?.length ? new Set(ids.map(orderKey)) : null;
  const q = String(query || "").trim().toLowerCase();
  return mapOrders.filter(({ order: o }) =>
    (!wanted || wanted.has(orderKey(o.id))) &&
    (!status || o.status === status) &&
    (!q || [o.id, o.product, o.supplier, o.destination, o.hsCode].some((v) => contains(v, q))),
  );
}

/** Order values summed per currency, in currency units (valueMinor is hundredths for every currency). */
export function totalsByCurrency(mapOrders) {
  const totals = {};
  for (const { order: o } of mapOrders) totals[o.currency] = (totals[o.currency] || 0) + o.valueMinor;
  return Object.fromEntries(Object.entries(totals).map(([c, minor]) => [c, minor / 100]));
}

/**
 * One order for the model: its fields, status as the Orders page words it, and its checklist.
 * cite(key, info) returns a ref number; orders and the official texts behind checks are citable.
 */
export function presentOrder(m, cite) {
  const o = m.order;
  const ref = cite(`order:${o.id}`, {
    type: "order",
    id: o.id,
    title: `${o.id} · ${o.product}`,
    // The browser demo has no map, so its orders link to their Orders page instead.
    url: m.url || `#/workspace/map/order/${encodeURIComponent(o.id)}`,
  });
  return {
    ref,
    id: o.id,
    product: o.product,
    supplier: o.supplier,
    destination: o.destination,
    market: m.placement?.market ?? null,
    value: o.valueMinor / 100,
    currency: o.currency,
    shipDate: o.shipDate,
    hsCode: o.hsCode,
    status: o.status,
    statusLabel: STATUS_LABELS[o.status] || o.status,
    gapCount: m.gapCount,
    checks: (m.checks || []).map((c) => ({
      title: c.title,
      level: c.level,
      status: c.status,
      gap: GAPS.has(c.status),
      note: c.note,
      source: c.source && {
        ref: cite(`regdoc:${c.source.documentId}`, {
          type: "regulation",
          id: c.source.documentId,
          title: `${c.source.regulationTitle} (${c.source.documentTitle}, version ${c.source.versionNumber})`,
          url: `#/workspace/regulations/documents/${encodeURIComponent(c.source.documentId)}`,
        }),
        regulation: c.source.regulationTitle,
        officialId: c.source.officialId || undefined,
        quote: c.source.quote?.length > MAX_QUOTE ? `${c.source.quote.slice(0, MAX_QUOTE)}…` : c.source.quote,
      },
    })),
  };
}

// The browser demo keeps its orders and playbook in the visitor's browser, so the chat
// request carries them (frontend/ai/chat/agent-client.ts). They come from the client, so
// they are checked and trimmed here; anything malformed is dropped, never trusted.
export const MAX_DEMO_ORDERS = 200;
export const MAX_DEMO_RULES = 50;
const DEMO_STATUSES = new Set(["exposed", "clear"]);
const CHECK_STATUSES = new Set(["missing", "on_file"]);
const text = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Demo orders in GET /trade-map's shape, or null when there are none to read. */
export function demoMapOrders(raw) {
  if (!Array.isArray(raw)) return null;
  const orders = [];
  for (const o of raw.slice(0, MAX_DEMO_ORDERS)) {
    if (!o || typeof o !== "object") continue;
    const id = text(o.id, 100);
    const value = Number(o.value);
    if (!id || !Number.isFinite(value) || value <= 0 || value >= 1e12 || !DAY.test(o.shipDate) || !DEMO_STATUSES.has(o.status)) continue;
    const check = o.check && CHECK_STATUSES.has(o.check.status) && text(o.check.title, 200) ? o.check : null;
    const checks = check ? [{ requirementKey: "sample", title: text(check.title, 200), level: "supplier", status: check.status, note: text(check.note, 300) || "" }] : [];
    orders.push({
      order: {
        id,
        product: text(o.product, 300) || "",
        supplier: text(o.supplier, 300) || "",
        destination: text(o.destination, 200) || "",
        valueMinor: Math.round(value * 100),
        currency: /^[A-Z]{3}$/.test(o.currency) ? o.currency : "USD",
        shipDate: o.shipDate,
        hsCode: text(o.hsCode, 20) || "",
        status: o.status,
      },
      placement: { market: typeof o.market === "string" && /^[A-Z]{2}$/.test(o.market) ? o.market : null },
      checks,
      gapCount: checks.filter((c) => GAPS.has(c.status)).length,
      url: `#/workspace/orders/${encodeURIComponent(id)}`,
    });
  }
  return orders.length ? orders : null;
}

/** The demo's playbook rules that are switched on, or null when there are none. */
export function demoPlaybook(raw) {
  if (!Array.isArray(raw)) return null;
  const rules = raw
    .slice(0, MAX_DEMO_RULES)
    .filter((r) => r && typeof r === "object" && r.enabled !== false)
    .map((r, i) => ({ id: text(r.id, 40) || String(i + 1), category: text(r.category, 40) || "Policy", text: text(r.text, 500), enabled: true }))
    .filter((r) => r.text);
  return rules.length ? rules : null;
}
