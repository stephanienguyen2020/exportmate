import { test } from "node:test";
import assert from "node:assert/strict";
import { citedRefs, figures, review, strayLinks, stripRefs, toEvidence } from "../review.js";

const retrieved = [
  { ref: 1, type: "query", title: "Stock query" },
  { ref: 2, type: "article", title: "EUDR delay", url: "https://news.example.com/eudr" },
];

test("parses citations and figures", () => {
  assert.deepEqual(citedRefs("A [1] and B [1, 2]."), [1, 2]);
  assert.equal(stripRefs("Total USD 1,165,971 [1]."), "Total USD 1,165,971.");
  assert.deepEqual(figures("USD 1,165,971.00 across 12 items, a 25% duty [3]"), ["1165971", "25"]);
});

test("passes an answer whose citations and figures trace to tool results", () => {
  const evidence = toEvidence('how much? {"totalStockValueUsd":1165971,"rate":"25%"}');
  const r = review({ answer: "The total is USD 1,165,971 [1], with a 25% duty [2].", retrieved, evidence, usedTools: true });
  assert.deepEqual(r.problems, []);
  assert.ok(r.checks.every((c) => c.ok));
  assert.equal(r.citations.length, 2);
});

test("catches unknown refs, invented figures, missing citations and stray links", () => {
  const evidence = toEvidence('{"totalStockValueUsd":1250}');
  const r = review({ answer: "The duty is 25% and stock is worth USD 9,999 [7]. Pay at https://evil.example.com/pay", retrieved, evidence, usedTools: true });
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed, [
    "Citations point to retrieved evidence",
    "Figures traceable to tool results",
    "Answer grounded in tool results",
    "Links come from retrieved sources",
  ]);
  // "25" is not accepted just because it appears inside 1250.
  assert.match(r.problems.join(" "), /25, 9999|9999, 25/);
});

test("links to a retrieved source are allowed", () => {
  assert.deepEqual(strayLinks("Read https://news.example.com/eudr.", retrieved), []);
  assert.deepEqual(strayLinks("See https://other.example.com/x", retrieved), ["https://other.example.com/x"]);
});

test("general-knowledge answers without tools are not figure-checked", () => {
  const r = review({ answer: "A certificate of origin dates back to the 1920s.", retrieved: [], evidence: "", usedTools: false });
  assert.ok(r.checks.every((c) => c.ok));
});
