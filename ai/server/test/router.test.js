import { test } from "node:test";
import assert from "node:assert/strict";
import { routeQuestion } from "../router.js";
import { goldenCases } from "../eval/golden.js";

const ask = (text) => routeQuestion([{ role: "user", text }]);

// Every golden case has an expected tier, so a new case has to decide where it belongs.
const EXPECTED = {
  "supplier-lookup": "simple",
  "category-count": "simple",
  "eu-missing-geolocation": "simple",
  "pefc-certified": "simple",
  "absent-certification": "simple",
  "pair-total-average": "complex",
  "follow-up-total": "complex",
  "latest-scan": "simple",
  "eudr-exposure": "complex",
  "scan-health": "simple",
  "how-to-add-source": "simple",
  "unknown-sku": "simple",
  "invented-duty-rate": "complex",
  vietnamese: "simple",
  "prompt-leak": "complex",
  "pasted-injection": "complex",
  "demo-order-status": "complex",
  "out-of-scope": "simple",
};

test("routes every golden case to its expected tier", () => {
  for (const c of goldenCases([], { rules: [] })) {
    assert.ok(EXPECTED[c.id], `no expected tier for golden case ${c.id}`);
    const { tier, reasons } = routeQuestion(c.messages);
    assert.equal(tier, EXPECTED[c.id], `${c.id}: ${tier} (${reasons.join(", ") || "no signals"})`);
  }
});

test("names the signals that sent a question to the complex tier", () => {
  assert.deepEqual(ask("Compare PLY-101 and PLY-102").reasons, ["several SKUs", "judgement"]);
  assert.deepEqual(ask("Which SKUs are exposed to the new tariff?").reasons, ["arithmetic", "trade rules"]);
  assert.deepEqual(ask("Tổng giá trị tồn kho là bao nhiêu?").reasons, ["arithmetic"]);
  assert.deepEqual(ask("Who supplies PLY-101?"), { tier: "simple", reasons: [] });
});

test("a follow-up always needs the conversation", () => {
  const r = routeQuestion([
    { role: "user", text: "Who supplies PLY-101?" },
    { role: "model", text: "An Phat Plywood." },
    { role: "user", text: "And where is it?" },
  ]);
  assert.deepEqual(r, { tier: "complex", reasons: ["follow-up"] });
});

test("pasted text and long questions go to the bigger model", () => {
  assert.equal(ask(`Our buyer wrote: "please confirm the shipment leaves before the end of the month as agreed"`).tier, "complex");
  assert.equal(ask("line one\nline two\nline three\nline four").tier, "complex");
  assert.equal(ask("x".repeat(301)).tier, "complex");
});

test("a forced tier wins", () => {
  assert.deepEqual(routeQuestion([{ role: "user", text: "Compare PLY-101 and PLY-102" }], { force: "simple" }), { tier: "simple", reasons: ["forced"] });
});
