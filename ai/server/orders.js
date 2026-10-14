// The signed-in company's orders as the query_orders tool shows them. They come from the
// company backend's GET /api/v1/trade-map (read with the user's own token): every order with
// its market's document checklist and the official text behind each line. Pure, so it is
// tested without the backend.

export const ORDER_STATUSES = ["exposed", "needs_data", "awaiting_analysis", "clear"];
// What the Orders page shows for each status (frontend/src/main.tsx).
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
    url: `#/workspace/map/order/${encodeURIComponent(o.id)}`,
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
