import { test } from "node:test";
import assert from "node:assert/strict";
import { REGISTRY, makeRefs, workspaceReaders } from "../agents/tools.js";
import { toolGateway } from "../gateway.js";
import { rulesFor } from "../policy.js";

const source = {
  regulationId: "r1",
  regulationTitle: "US Section 232 duties on timber",
  officialId: "Proclamation 10976",
  documentId: "d232",
  documentTitle: "Proclamation 10976",
  versionNumber: 1,
  sourceUrl: "https://www.federalregister.gov/x",
  quote: "a 25 percent ad valorem duty rate",
};
// GET /orders/PO-2291/what-if?market=UK as the backend answers it (trimmed).
const toUk = {
  orderId: "PO-2291",
  kind: "market",
  fromMarket: "EU",
  toMarket: "UK",
  routePoints: [{ latitude: 1, longitude: 2 }],
  reuse: [{ title: "Timber legality evidence", note: "VNTLAS legality dossier.", tag: null }],
  reevaluate: [{ title: "Proof of origin", note: "Re-issue: EVFTA → UKVFTA.", tag: "Changes" }],
  unknown: [{ title: "Import duty", note: "Depends on the UK tariff line.", tag: null }],
  dropped: ["Plot-level geolocation"],
  assumptions: [],
};
const changes = {
  start: "2026-11-25",
  until: "2027-11-25",
  days: 365,
  changes: [{ on: "2027-01-01", kind: "changes", market: "US", marketName: "United States", requirementKey: "tariff", title: "Section 232 tariff category", whatChanges: "A later increase on 1 January 2027.", orderIds: [], source }],
};

test("the what-if and rule changes are read from the backend with the caller's token, never in the demo", async () => {
  const asked = [];
  const backend = async (path) => (asked.push(path), { status: 200, body: { data: path.includes("what-if") ? toUk : changes } });
  const readers = workspaceReaders(backend, null);
  assert.equal((await readers.whatIf({ orderId: "PO|42", market: "UK" })).toMarket, "UK");
  await readers.changes(365);
  await readers.changes();
  assert.deepEqual(asked, ["/api/v1/orders/PO%7C42/what-if?market=UK", "/api/v1/market-requirements/changes?days=365", "/api/v1/market-requirements/changes"]);
  const demo = workspaceReaders(null, { orders: [] });
  assert.equal(demo.whatIf, null);
  assert.equal(demo.changes, null);
});

test("a what-if the backend refuses goes back to the model with its reason", async () => {
  const readers = workspaceReaders(async () => ({ status: 422, body: { error: { message: "PO-2291 already ships to the European Union." } } }), null);
  await assert.rejects(readers.whatIf({ orderId: "PO-2291", market: "EU" }), (e) => e.kind === "invalid_args" && /already ships/.test(e.message));
  const down = workspaceReaders(async () => ({ status: 503, body: {} }), null);
  await assert.rejects(down.whatIf({ orderId: "PO-2291", market: "UK" }), (e) => e.status === 503);
});

test("compare_order takes exactly one change and cites the comparison on the order's map", async () => {
  const refs = makeRefs();
  let asked;
  const whatIf = async (a) => ((asked = a), toUk);
  const { output } = await REGISTRY.compare_order.run({ orderId: "PO-2291", market: "UK" }, { refs, whatIf });
  assert.deepEqual(asked, { orderId: "PO-2291", market: "UK" });
  assert.equal(output.routePoints, undefined);
  assert.deepEqual([output.reuse.length, output.reevaluate[0].tag, output.dropped], [1, "Changes", ["Plot-level geolocation"]]);
  const [cited] = refs.all();
  assert.equal(cited.url, "#/workspace/map/order/PO-2291");
  assert.match(cited.title, /What if PO-2291 went to UK: reuse 1, recheck 1, unknown 1/);
  for (const args of [{ orderId: "PO-2291" }, { orderId: "PO-2291", market: "UK", via: "SG" }])
    await assert.rejects(REGISTRY.compare_order.run(args, { refs, whatIf }), /exactly one change/);
});

test("upcoming_changes cites each change's official text and keeps days within a year", async () => {
  const refs = makeRefs();
  let asked;
  const read = async (days) => ((asked = days), changes);
  const { output } = await REGISTRY.upcoming_changes.run({ days: 900 }, { refs, changes: read });
  assert.equal(asked, 365);
  const [change] = output.changes;
  assert.deepEqual([change.on, change.market, change.orderIds], ["2027-01-01", "US", []]);
  assert.equal(refs.all().find((c) => c.ref === change.source.ref).url, "#/workspace/regulations/documents/d232");
  await REGISTRY.upcoming_changes.run({}, { refs, changes: read });
  assert.equal(asked, undefined);
});

test("the two tools and their rules come only with a company backend", () => {
  const company = toolGateway(REGISTRY, { refs: makeRefs(), whatIf: async () => toUk, changes: async () => changes }, { maxCalls: 5 });
  const demo = toolGateway(REGISTRY, { refs: makeRefs(), whatIf: null, changes: null }, { maxCalls: 5 });
  const offered = (g) => g.declarations().map((d) => d.name);
  assert.ok(["compare_order", "upcoming_changes"].every((n) => offered(company).includes(n)));
  assert.ok(!offered(demo).some((n) => ["compare_order", "upcoming_changes"].includes(n)));
  const ids = (session) => rulesFor(session).map((r) => r.id);
  assert.ok(ids({ whatIf: () => {}, changes: () => {} }).includes("order-what-if"));
  assert.ok(ids({ whatIf: () => {}, changes: () => {} }).includes("rule-changes"));
  assert.ok(!ids({}).includes("order-what-if"));
});
