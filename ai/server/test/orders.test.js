import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DEMO_ORDERS, demoMapOrders, demoPlaybook, matchOrders, presentOrder, totalsByCurrency } from "../orders.js";

const source = {
  regulationId: "r1",
  regulationTitle: "EU Deforestation Regulation",
  officialId: "2023/1115",
  documentId: "d1",
  documentTitle: "Regulation (EU) 2023/1115",
  versionNumber: 2,
  sourceUrl: "https://eur-lex.europa.eu/eli/reg/2023/1115/oj",
  quote: "x".repeat(400),
};
const mapOrder = (order, checks = []) => ({
  order: { product: "Acacia plywood · 18 mm", supplier: "Binh Phu Wood", destination: "Rotterdam, NL", valueMinor: 2400000, currency: "USD", shipDate: "2026-10-27", hsCode: "4412.33", status: "exposed", ...order },
  placement: { city: "Rotterdam", country: "NL", market: "EU", location: null, approximate: false },
  checks,
  gapCount: checks.filter((c) => ["missing", "mismatch"].includes(c.status)).length,
});
const orders = [
  mapOrder({ id: "PO-2291" }, [
    { requirementKey: "eudr-dds", title: "EUDR due diligence statement", level: "shipment", status: "missing", note: "No geolocation on file.", source },
    { requirementKey: "phyto", title: "Phytosanitary certificate", level: "shipment", status: "prepare", note: "Prepare per shipment.", source },
  ]),
  mapOrder({ id: "PO-2302", product: "Oak dining chair", supplier: "Thanh Long", destination: "Tokyo, JP", valueMinor: 150000000, currency: "JPY", status: "clear" }),
  mapOrder({ id: "PO-2310", destination: "Hamburg, DE", valueMinor: 1050050, status: "awaiting_analysis" }),
];

test("finds an order by id however it is written", () => {
  for (const id of ["PO-2291", "po 2291", "po2291"]) assert.deepEqual(matchOrders(orders, { ids: [id] }).map((m) => m.order.id), ["PO-2291"]);
  assert.deepEqual(matchOrders(orders, { ids: ["PO-9999"] }), []);
});

test("filters by text and status, combined with AND", () => {
  assert.deepEqual(matchOrders(orders, { query: "plywood" }).map((m) => m.order.id), ["PO-2291", "PO-2310"]);
  assert.deepEqual(matchOrders(orders, { query: "tokyo" }).map((m) => m.order.id), ["PO-2302"]);
  assert.deepEqual(matchOrders(orders, { query: "plywood", status: "exposed" }).map((m) => m.order.id), ["PO-2291"]);
  assert.equal(matchOrders(orders, {}).length, 3);
});

test("totals values per currency from hundredths", () => {
  assert.deepEqual(totalsByCurrency(orders), { USD: 34500.5, JPY: 1500000 });
});

test("presents an order with its status label, gaps and cited official texts", () => {
  const cited = [];
  const cite = (key, info) => {
    let n = cited.findIndex((c) => c.key === key) + 1;
    if (!n) n = cited.push({ key, ...info });
    return n;
  };
  const o = presentOrder(orders[0], cite);
  assert.equal(o.value, 24000);
  assert.equal(o.statusLabel, "Action needed");
  assert.equal(o.market, "EU");
  assert.equal(o.gapCount, 1);
  assert.deepEqual(o.checks.map((c) => [c.status, c.gap]), [["missing", true], ["prepare", false]]);
  assert.equal(o.checks[0].source.ref, o.checks[1].source.ref, "one citation per official text");
  assert.ok(o.checks[0].source.quote.length <= 301);
  assert.deepEqual(cited.map((c) => [c.type, c.url]), [
    ["order", "#/workspace/map/order/PO-2291"],
    ["regulation", "#/workspace/regulations/documents/d1"],
  ]);
});

const demoOrder = (o = {}) => ({
  id: "PO-9001",
  product: "Acacia plywood 18mm",
  supplier: "Binh Phu Wood",
  destination: "Rotterdam, NL",
  market: "EU",
  value: 30000,
  currency: "USD",
  shipDate: "2026-11-20",
  hsCode: "4412.33",
  status: "exposed",
  check: { title: "Geolocation documentation for EU-bound wood (sample rule)", status: "missing", note: "Binh Phu Wood has no geolocation record for this lot." },
  ...o,
});

test("the browser demo's orders become map orders the order tool can read", () => {
  const [m] = demoMapOrders([demoOrder()]);
  assert.equal(m.order.valueMinor, 3000000);
  assert.equal(m.placement.market, "EU");
  assert.equal(m.gapCount, 1);
  assert.deepEqual(matchOrders([m], { ids: ["po 9001"] }), [m]);
  const cited = [];
  const o = presentOrder(m, (key, info) => cited.push({ key, ...info }));
  assert.equal(o.statusLabel, "Action needed");
  assert.deepEqual(o.checks.map((c) => [c.status, c.gap, c.source]), [["missing", true, undefined]]);
  assert.equal(cited[0].url, "#/workspace/orders/PO-9001", "the demo has no map, so orders link to their page");
});

test("malformed demo orders are dropped, long text trimmed and the count capped", () => {
  const bad = [null, "x", demoOrder({ id: "" }), demoOrder({ value: -5 }), demoOrder({ value: "abc" }), demoOrder({ shipDate: "soon" }), demoOrder({ status: "needs_data" })];
  assert.equal(demoMapOrders(bad), null);
  assert.equal(demoMapOrders("orders"), null);
  const [m] = demoMapOrders([demoOrder({ product: "p".repeat(1000), currency: "dollars", market: "Europe", check: { status: "hacked", title: "x" } })]);
  assert.equal(m.order.product.length, 300);
  assert.equal(m.order.currency, "USD");
  assert.equal(m.placement.market, null);
  assert.deepEqual(m.checks, []);
  const many = Array.from({ length: MAX_DEMO_ORDERS + 20 }, (_, i) => demoOrder({ id: `PO-${i}` }));
  assert.equal(demoMapOrders(many).length, MAX_DEMO_ORDERS);
});

test("the demo's playbook keeps only rules that are switched on and have text", () => {
  const rules = demoPlaybook([
    { id: "1", category: "Supplier", text: "Allow Binh Phu Wood 3 weeks.", enabled: true },
    { id: "2", category: "Policy", text: "Off", enabled: false },
    { id: "3", category: "Threshold", text: "   " },
    "rule",
  ]);
  assert.deepEqual(rules, [{ id: "1", category: "Supplier", text: "Allow Binh Phu Wood 3 weeks.", enabled: true }]);
  assert.equal(demoPlaybook([]), null);
  assert.equal(demoPlaybook({}), null);
});
