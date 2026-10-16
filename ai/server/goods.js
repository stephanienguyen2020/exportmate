// A company's goods for News watch: what its profile (Account › About company) says it makes
// and what its orders ship. The scan judges each day's news against them as it does the
// sample stock, and the backend suggests orders for an alert from their HS codes and markets,
// so each item has the sample stock's shape (sku, name, hsCode, markets, supplier), without
// quantities or costs. Pure; goods-store.js reads the profile and orders with a member's token.
import { createHash } from "node:crypto";

// Items per company, so a scan's prompt stays a reasonable size.
export const MAX_GOODS = 60;
// Order ids kept on an item, for the assistant and the stock list.
const MAX_ORDER_IDS = 10;
const MAX_ABOUT = 600;

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const digits = (hs) => String(hs ?? "").replace(/\D/g, "");

/** A stable id for a product and its HS code, so alerts keep naming the same item. */
export function goodsId(name, hsCode = "") {
  const key = `${clean(name).toLowerCase()}|${digits(hsCode)}`;
  return `G-${createHash("sha1").update(key).digest("hex").slice(0, 6).toUpperCase()}`;
}

/** "Cotton T-shirts, roasted coffee; LED lamps" as separate products. */
export function profileProducts(text) {
  return [...new Set(String(text ?? "").split(/[,;\n]+/).map(clean).filter((p) => p.length >= 2))];
}

/** One line about the company, from its profile, for the scan's prompt. */
export function aboutCompany(c) {
  const route = [c.origin, ...(c.transit || []), c.destination].map(clean).filter(Boolean);
  const parts = [
    `a ${clean(c.businessRole).toLowerCase() || "company"}${c.origin ? ` based in ${clean(c.origin)}` : ""}${route.length > 1 ? ` shipping ${route.join(" → ")}` : ""}`,
    clean(c.description).replace(/[.\s]+$/, ""),
    c.materials && `main materials: ${clean(c.materials)}`,
    c.certifications && `certifications: ${clean(c.certifications)}`,
  ];
  return parts.filter(Boolean).join("; ").slice(0, MAX_ABOUT);
}

/**
 * { profile, items } from the company profile (GET /api/v1/company/knowledge's `company`) and
 * its orders (GET /api/v1/trade-map's `orders`: { order, placement }). Products the profile
 * names come first; then orders with the same product and HS code make one item, with every
 * market and supplier, newest ship dates first. `profile` is what scan.js's prompt needs.
 */
export function companyGoods(company, mapOrders = []) {
  const items = new Map();
  for (const name of profileProducts(company?.products))
    items.set(goodsId(name), { sku: goodsId(name), name, hsCode: "", markets: [], suppliers: [], orders: [], source: "profile" });
  const named = new Set([...items.values()].map((i) => i.name.toLowerCase()));
  const byDate = [...(mapOrders || [])]
    .filter((m) => clean(m?.order?.product))
    .sort((a, b) => String(b.order.shipDate ?? "").localeCompare(String(a.order.shipDate ?? "")));
  for (const { order, placement } of byDate) {
    const name = clean(order.product);
    // A product the profile names and an order ships with no HS code is the same item.
    const id = !digits(order.hsCode) && named.has(name.toLowerCase()) ? goodsId(name) : goodsId(name, order.hsCode);
    const item = items.get(id) ?? { sku: id, name, hsCode: clean(order.hsCode), markets: [], suppliers: [], orders: [], source: "orders" };
    const market = placement?.market;
    if (market && !item.markets.includes(market)) item.markets.push(market);
    const supplier = clean(order.supplier);
    if (supplier && !item.suppliers.includes(supplier)) item.suppliers.push(supplier);
    if (item.orders.length < MAX_ORDER_IDS) item.orders.push(order.id);
    items.set(id, item);
  }
  return {
    profile: { company: clean(company?.name), about: company ? aboutCompany(company) : "" },
    items: [...items.values()].slice(0, MAX_GOODS).map(({ suppliers, ...i }) => ({ ...i, supplier: suppliers.join(", ") })),
  };
}

/** The same goods give the same fingerprint, so a refresh that changed nothing is noticed. */
export const goodsFingerprint = (goods) => createHash("sha1").update(JSON.stringify(goods)).digest("hex").slice(0, 16);
