import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES } from "../policy.js";
import { examCases } from "../eval/exam.js";

const TODAY = "2026-12-01";
const check = (requirementKey, status, title = requirementKey) => ({ requirementKey, status, title });
const order = (id, { market = "EU", shipDate = "2026-12-10", supplier = "Binh Phu Wood", value = 2400000, checks = [] } = {}) => ({
  order: { id, product: "Acacia plywood", supplier, destination: "Rotterdam, NL", valueMinor: value, currency: "USD", shipDate, hsCode: "4412.33", status: "exposed" },
  placement: { market },
  checks,
  gapCount: checks.filter((c) => ["missing", "mismatch"].includes(c.status)).length,
});

// The demo company's shape (backend/app/seed_demo_data.py): two EU orders from a supplier with no
// geolocation, a US order, Japanese orders, and one order already shipped.
const company = {
  today: TODAY,
  markets: [{ code: "EU", name: "European Union" }, { code: "JP", name: "Japan" }],
  orders: [
    order("PO-2291", { checks: [check("geolocation", "missing", "Plot geolocation"), check("legality", "on_file")] }),
    order("PO-2304", { shipDate: "2026-12-13", checks: [check("geolocation", "missing", "Plot geolocation")] }),
    order("PO-2320", { market: "US", shipDate: "2026-12-25", supplier: "An Cuong Wood", value: 5430000 }),
    order("PO-2311", { market: "JP", shipDate: "2026-12-05", supplier: "Mekong Timber", value: 1350000 }),
    order("PO-2313", { market: "JP", shipDate: "2026-12-08", supplier: "Mekong Timber", value: 1650050 }),
    order("PO-2315", { market: "JP", shipDate: "2026-12-09", supplier: "Mekong Timber", value: 1200000 }),
    order("PO-2200", { shipDate: "2026-11-01" }),
  ],
  suppliers: [
    { name: "Mekong Timber", sourcing: [] },
    { name: "An Cuong Wood", sourcing: [{ materialName: "Acacia", country: "VN", formName: "logs" }, { materialName: "Rubberwood", country: "VN", formName: null }] },
  ],
  rules: [{ text: "Allow Binh Phu Wood 3 weeks to provide any new documentation." }, { text: "EU orders need owner review." }],
  acacia: { matches: [{ orderId: "PO-2291", supplier: "Binh Phu Wood", path: [{ label: "Acacia from Vietnam" }, { label: "Binh Phu Wood" }, { label: "PO-2291" }] }] },
};
const cases = examCases(company, { policyRules: RULES });
const byId = (id) => cases.find((c) => c.id === id);

test("the exam's answers are worked out from the company's data", () => {
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  for (const c of cases) assert.ok(c.set === "company" && c.messages.at(-1).text === c.question && Object.keys(c.expect).length, c.id);
  // Open EU orders, and the shipped one left out.
  assert.deepEqual(byId("company-eu-gaps").expect.contains, ["PO-2291", "PO-2304", "PO-2291", "PO-2304"]);
  assert.match(byId("company-order-status").question, /PO-2291/);
  assert.deepEqual(byId("company-order-status").expect.containsAny, ["Plot geolocation"]);
  assert.deepEqual(byId("company-next-shipment").expect.contains, ["PO-2311"]);
  assert.deepEqual(byId("company-no-geolocation").expect.contains, ["Binh Phu Wood"]);
  assert.match(byId("company-supplier-sourcing").question, /An Cuong Wood/);
  assert.deepEqual(byId("company-playbook-count").expect.contains, ["2"]);
  assert.deepEqual(byId("company-graph-acacia").expect.contains, ["PO-2291"]);
  assert.match(byId("company-graph-why").rubric, /Acacia from Vietnam → Binh Phu Wood → PO-2291/);
  // The market with the most open orders in one currency: Japan (3) over the EU (2, the shipped one left out).
  assert.match(byId("company-market-total").question, /to Japan\?/);
  assert.deepEqual(byId("company-market-total").expect.contains, ["42000.50"]);
  // The demo video's questions, with their answers from the same data.
  assert.equal(byId("demo-duty-calc").question, "PO-2291 is worth $24,000. At a 4.7% duty, how much is the duty?");
  assert.deepEqual(byId("demo-duty-calc").expect.contains, ["1128"]);
  assert.deepEqual(byId("demo-playbook-rules").expect.contains, ["Binh Phu Wood"]);
  assert.deepEqual(byId("demo-eu-border").expect.contains, ["PO-2291", "PO-2304"]);
  // Supplier documents, markets and what-ifs, and follow-ups.
  assert.match(byId("company-supplier-documents").question, /Binh Phu Wood/);
  assert.deepEqual(byId("company-supplier-documents").expect.containsAny, ["Plot geolocation"]);
  assert.deepEqual(byId("company-documents-on-file").expect.containsAny, ["legality"]);
  assert.deepEqual(byId("company-markets").expect.contains, ["JP", "EU", "US"]);
  assert.match(byId("company-whatif-market").question, /PO-2291 went to Japan/);
  assert.equal(byId("company-follow-up-total").messages.length, 3);
  assert.deepEqual(byId("company-follow-up-total").expect.contains, ["48000"]);
  assert.equal(byId("company-follow-up-why").question, "Why is the first one missing them?");
  // By level. Open orders by ship date: PO-2311, 2313, 2315 (JP), 2291, 2304 (EU), 2320 (US).
  assert.deepEqual(byId("easy-open-count").expect.contains, ["6"]);
  assert.deepEqual(byId("easy-order-supplier").expect.contains, ["Mekong Timber"]);
  assert.deepEqual(byId("easy-order-hs").expect.contains, ["4412.33"]);
  assert.deepEqual(byId("medium-largest-order").expect.contains, ["PO-2320", "54300"]);
  assert.deepEqual(byId("medium-busiest-supplier").expect.contains, ["Mekong Timber", "3"]);
  assert.deepEqual(byId("medium-follow-up-first").expect.contains, ["PO-2311"]);
  assert.deepEqual(byId("hard-due-soon-gaps").expect.contains, ["PO-2291", "PO-2304"]);
  assert.deepEqual(byId("hard-supplier-risk").expect.contains, ["PO-2291", "PO-2304", "48000"]);
  assert.deepEqual(byId("hard-market-compare").expect.contains, ["48000", "54300"]);
});

test("questions the data can't support are left out", () => {
  const bare = examCases({ today: TODAY, orders: [], suppliers: [], rules: [], acacia: { matches: [] } });
  const kept = bare.map((c) => c.id);
  for (const id of ["company-order-status", "company-next-shipment", "company-graph-acacia", "company-market-total", "company-vietnamese"])
    assert.ok(!kept.includes(id), id);
  assert.ok(kept.includes("company-unknown-order") && kept.includes("company-prompt-leak"));
});
