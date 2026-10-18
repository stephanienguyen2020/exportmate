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

test("cited news must carry its publication date", () => {
  const news = [
    { ref: 1, type: "query", title: "Alert exposure" },
    { ref: 2, type: "alert", title: "EUDR checks tighten", publishedAt: "2026-10-05T08:00:00.000Z" },
    { ref: 3, type: "article", title: "Plywood duties", publishedAt: "2026-09-12T00:00:00.000Z" },
  ];
  const evidence = toEvidence('{"sku":"PLY-103","stockValueUsd":211380,"publishedAt":"2026-10-05","date":"2026-09-12"}');
  const undated = review({ answer: "USD 211,380 is exposed [1], mainly PLY-103 [2]; duties may follow [3].", retrieved: news, evidence, usedTools: true });
  const failed = undated.checks.find((c) => c.name === "News cited with its date");
  assert.equal(failed.ok, false);
  assert.match(undated.problems.join(" "), /\[2\] 2026-10-05, \[3\] 2026-09-12/);
  const dated = review({
    answer: "USD 211,380 is exposed [1], mainly PLY-103 (EUDR news of 5 October 2026 [2]); duties may follow (2026-09-12 [3]).",
    retrieved: news,
    evidence,
    usedTools: true,
  });
  assert.deepEqual(dated.problems, []);
});

test("mentionsDate accepts common forms and rejects other days", async () => {
  const { mentionsDate } = await import("../review.js");
  const iso = "2026-10-05T08:00:00Z";
  for (const t of ["2026-10-05", "5 October", "Oct. 5", "October 5th", "5th of October", "ngày 5/10", "5 tháng 10"]) assert.ok(mentionsDate(t, iso), t);
  for (const t of ["15 October", "October 15", "5 November", "2026-10-15", "105/10"]) assert.equal(mentionsDate(t, iso), false, t);
});

test("a decimal figure is traced in evidence written with trailing zeros (HS codes)", () => {
  const { problems } = review({ answer: "Wooden furniture (HS 9403.30, 9403.40) [1].", retrieved, evidence: toEvidence("Wooden furniture (HS 9403.30, 9403.40)"), usedTools: true });
  assert.deepEqual(problems, []);
  // Still whole numbers: 9403.3 is not 9403.35.
  assert.match(review({ answer: "HS 9403.3 [1]", retrieved, evidence: "HS 9403.35", usedTools: true }).problems.join(), /9403\.3/);
});
