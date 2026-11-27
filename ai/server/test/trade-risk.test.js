import { test } from "node:test";
import assert from "node:assert/strict";
import { REGISTRY, makeRefs, tradeRiskPath, workspaceReaders } from "../agents/tools.js";
import { toolGateway } from "../gateway.js";
import { RULES, rulesFor } from "../policy.js";

// GET /api/v1/trade-risk/orders/PO-1's answer (backend tests).
const scored = {
  orderId: "PO-1",
  market: "EU",
  exporter: "VN",
  hs6: "441233",
  status: "scored",
  level: "high",
  score: 0.02,
  reasons: [{ feature: "import_value_vs_last_year", text: "Imports grew 4.0× in a year" }],
  modelVersion: "2026-11-24",
  dataFrom: "2025-09",
  dataTo: "2026-08",
  dataSource: "comtrade",
  similarCases: [{ caseId: "EU-AD-1", kind: "AD", market: "EU", exporter: "CN", hs6: "441233", year: 2024, product: "Plywood", outcome: "duty imposed", dutyPct: 25.5 }],
  sources: ["Source: UN Comtrade", "CEPII BACI"],
};

test("get_trade_risk's arguments become the backend's path", () => {
  assert.equal(tradeRiskPath({ orderId: "PO 1" }), "/api/v1/trade-risk/orders/PO%201");
  assert.equal(tradeRiskPath({ destination: "KR", hsCode: "4412.33" }), "/api/v1/trade-risk?destination=KR&hsCode=4412.33");
  assert.equal(tradeRiskPath({ destination: "US", hsCode: "441233", exporter: "ID" }), "/api/v1/trade-risk?destination=US&hsCode=441233&exporter=ID");
});

test("the risk is read from the company backend with the caller's token, never in the demo", async () => {
  const asked = [];
  const readers = workspaceReaders(async (path) => (asked.push(path), { status: 200, body: { data: scored } }), null);
  assert.deepEqual(await readers.tradeRisk({ orderId: "PO-1" }), scored);
  assert.deepEqual(asked, ["/api/v1/trade-risk/orders/PO-1"]);
  assert.equal(workspaceReaders(null, { orders: [] }).tradeRisk, null);
});

test("get_trade_risk cites the risk once and gives its reasons, figures' period and past cases", async () => {
  const refs = makeRefs();
  const { output, audit } = await REGISTRY.get_trade_risk.run({ orderId: "PO-1" }, { refs, tradeRisk: async () => scored });
  assert.equal(output.level, "high");
  assert.deepEqual(output.reasons, ["Imports grew 4.0× in a year"]);
  assert.deepEqual(output.figures, { source: "UN Comtrade (monthly)", from: "2025-09", to: "2026-08" });
  assert.equal(output.similarCases[0].kind, "anti-dumping");
  assert.equal(output.credit, "Source: UN Comtrade");
  assert.equal(output.score, undefined); // the level, never the raw probability
  const [cited] = refs.all();
  assert.equal(cited.type, "trade_risk");
  assert.equal(cited.url, "#/workspace/orders/PO-1");
  assert.match(cited.title, /PO-1 \(EU ← VN, HS 441233\): high risk, model 2026-11-24/);
  assert.equal(audit.count, 1);
});

test("get_trade_risk needs an order or a destination and HS code, and a company workspace", async () => {
  const refs = makeRefs();
  await assert.rejects(REGISTRY.get_trade_risk.run({ destination: "KR" }, { refs, tradeRisk: async () => scored }), /orderId, or a destination/);
  const demo = toolGateway(REGISTRY, { refs, tradeRisk: null }, { maxCalls: 5 });
  assert.ok(!demo.declarations().some((d) => d.name === "get_trade_risk"));
  assert.equal((await demo.call("get_trade_risk", { orderId: "PO-1" })).errorKind, "denied");
});

test("the trade risk rule applies only where the tool does", () => {
  assert.ok(RULES.some((r) => r.id === "trade-risk"));
  assert.ok(!rulesFor({ company: {} }).some((r) => r.id === "trade-risk"));
  assert.ok(rulesFor({ tradeRisk: async () => scored }).some((r) => r.id === "trade-risk"));
});
