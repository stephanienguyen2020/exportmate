import { test } from "node:test";
import assert from "node:assert/strict";
import { REGISTRY, makeRefs } from "../agents/tools.js";
import { MAX_DEMO_ORDERS, demoOrders, demoPlaybook, matchOrders, ordersQuery, presentOrder, totalsByCurrency } from "../orders.js";

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
// An order as GET /orders?checklist=all returns it.
const listedOrder = (order, checks = [], market = "EU") => ({
  product: "Acacia plywood · 18 mm",
  supplier: "Binh Phu Wood",
  destination: "Rotterdam, NL",
  valueMinor: 2400000,
  currency: "USD",
  shipDate: "2026-10-27",
  hsCode: "4412.33",
  status: "exposed",
  ...order,
  placement: { city: "Rotterdam", country: "NL", market, location: null, approximate: false },
  checks,
  gapCount: checks.filter((c) => ["missing", "mismatch"].includes(c.status)).length,
});
const orders = [
  listedOrder({ id: "PO-2291" }, [
    { requirementKey: "eudr-dds", title: "EUDR due diligence statement", level: "shipment", status: "missing", note: "No geolocation on file.", source },
    { requirementKey: "phyto", title: "Phytosanitary certificate", level: "shipment", status: "prepare", note: "Prepare per shipment.", source },
  ]),
  listedOrder({ id: "PO-2302", product: "Oak dining chair", supplier: "Thanh Long", destination: "Tokyo, JP", valueMinor: 150000000, currency: "JPY", status: "clear" }, [], "JP"),
  listedOrder({ id: "PO-2310", destination: "Hamburg, DE", valueMinor: 1050050, status: "awaiting_analysis" }),
];
const ids = (list) => list.map((o) => o.id);

test("query_orders' arguments become GET /orders' query string", () => {
  assert.equal(ordersQuery({ market: "EU", id: ["PO-1", "PO-2"] }, 200), "market=EU&id=PO-1&id=PO-2&checklist=gaps&limit=200");
  assert.equal(ordersQuery({ status: "clear", q: "oak", checklist: "all" }, 200), "status=clear&q=oak&checklist=all&limit=200");
});

test("the demo's orders are filtered as GET /orders filters: id however written, text, market, status", () => {
  for (const id of ["PO-2291", "po 2291", "po2291"]) assert.deepEqual(ids(matchOrders(orders, { id: [id] })), ["PO-2291"]);
  assert.deepEqual(matchOrders(orders, { id: ["PO-9999"] }), []);
  assert.deepEqual(ids(matchOrders(orders, { q: "plywood" })), ["PO-2291", "PO-2310"]);
  assert.deepEqual(ids(matchOrders(orders, { q: "tokyo" })), ["PO-2302"]);
  assert.deepEqual(ids(matchOrders(orders, { q: "plywood", status: "exposed" })), ["PO-2291"]);
  assert.deepEqual(ids(matchOrders(orders, { market: "jp" })), ["PO-2302"]);
  assert.equal(matchOrders(orders, {}).length, 3);
});

test("the checklist comes as asked: gaps by default, all, or none", () => {
  const [gaps] = matchOrders(orders, { id: ["PO-2291"] });
  assert.deepEqual(gaps.checks.map((c) => c.status), ["missing"]);
  assert.equal(matchOrders(orders, { id: ["PO-2291"], checklist: "all" })[0].checks.length, 2);
  const [none] = matchOrders(orders, { id: ["PO-2291"], checklist: "none" });
  assert.equal(presentOrder(none, () => 1).checks, undefined);
  assert.equal(presentOrder(none, () => 1).gapCount, 1);
});

test("query_orders passes its filters to the reader and totals every match", async () => {
  let asked;
  const run = (args) =>
    REGISTRY.query_orders.run(args, { refs: makeRefs(), orders: async (a) => ((asked = a), matchOrders(orders, a)) });
  const { output } = await run({ market: "EU", limit: 1 });
  assert.deepEqual(asked, { market: "EU", limit: 1 });
  assert.equal(output.matching, 2);
  assert.deepEqual(output.totalValueByCurrency, { USD: 34500.5 });
  assert.deepEqual(ids(output.orders), ["PO-2291"]);
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

test("the browser demo's orders take GET /orders' shape for the order tool", () => {
  const [m] = demoOrders([demoOrder()]);
  assert.equal(m.valueMinor, 3000000);
  assert.equal(m.placement.market, "EU");
  assert.equal(m.gapCount, 1);
  assert.deepEqual(ids(matchOrders([m], { id: ["po 9001"], checklist: "all" })), ["PO-9001"]);
  const cited = [];
  const o = presentOrder(m, (key, info) => cited.push({ key, ...info }));
  assert.equal(o.statusLabel, "Action needed");
  assert.deepEqual(o.checks.map((c) => [c.status, c.gap, c.source]), [["missing", true, undefined]]);
  assert.equal(cited[0].url, "#/workspace/orders/PO-9001", "the demo has no map, so orders link to their page");
});

test("malformed demo orders are dropped, long text trimmed and the count capped", () => {
  const bad = [null, "x", demoOrder({ id: "" }), demoOrder({ value: -5 }), demoOrder({ value: "abc" }), demoOrder({ shipDate: "soon" }), demoOrder({ status: "needs_data" })];
  assert.equal(demoOrders(bad), null);
  assert.equal(demoOrders("orders"), null);
  const [m] = demoOrders([demoOrder({ product: "p".repeat(1000), currency: "dollars", market: "Europe", check: { status: "hacked", title: "x" } })]);
  assert.equal(m.product.length, 300);
  assert.equal(m.currency, "USD");
  assert.equal(m.placement.market, null);
  assert.deepEqual(m.checks, []);
  const many = Array.from({ length: MAX_DEMO_ORDERS + 20 }, (_, i) => demoOrder({ id: `PO-${i}` }));
  assert.equal(demoOrders(many).length, MAX_DEMO_ORDERS);
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
