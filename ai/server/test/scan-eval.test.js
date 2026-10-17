import { test } from "node:test";
import assert from "node:assert/strict";
import { generateInventory } from "../seed/inventory.js";
import { decide } from "../relevance.js";
import { scanCases } from "../eval/scan-golden.js";
import { inBatches, mergeRepeats, scoreMentions, scoreScanCases, summarizeScanRun } from "../eval/scan-score.js";

const items = generateInventory();
const bySku = new Map(items.map((i) => [i.sku, i]));
const cases = scanCases(items, { today: new Date("2026-10-14T00:00:00Z") });
const byId = (id) => cases.find((c) => c.id === id);

test("labeled articles have unique ids, both labels and stock-backed expectations", () => {
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  assert.ok(cases.filter((c) => c.expect.relevant).length >= 8);
  assert.ok(cases.filter((c) => !c.expect.relevant).length >= 8);
  for (const c of cases.filter((c) => c.expect.relevant)) {
    assert.ok(c.expect.skus.length, `${c.id} names no SKU`);
    for (const sku of [...c.expect.skus, ...c.expect.allowed]) assert.ok(bySku.has(sku), `${c.id}: ${sku}`);
  }
  assert.deepEqual(byId("us-232-cabinets").expect.skus, ["CAB-101", "CAB-102"]);
  assert.deepEqual(byId("russia-birch-sanctions").expect.skus, ["HWP-101", "CAB-102"]);
  assert.match(byId("us-232-cabinets").article.snippet, /2026-12-13/);
});

test("batches keep the reports of one event together", () => {
  const batches = inBatches(cases, 16);
  assert.equal(batches.flat().length, cases.length);
  assert.ok(batches.every((b) => b.length <= 16));
  const events = new Set(cases.filter((c) => c.event).map((c) => c.event));
  for (const e of events) assert.equal(batches.filter((b) => b.some((c) => c.event === e)).length, 1, e);
  // An event that doesn't fit in the current batch starts the next one.
  const small = inBatches([{ id: "a" }, { id: "b", event: "x" }, { id: "c", event: "x" }], 2);
  assert.deepEqual(small.map((b) => b.map((c) => c.id)), [["a"], ["b", "c"]]);
});

test("decide keeps only stock SKUs and drops repeats and other commodities", () => {
  const timber = { title: "US tariff on plywood", snippet: "" };
  const kept = decide(timber, { relevant: true, affected: [{ sku: "PLY-102", reason: "US" }, { sku: "NOPE-1", reason: "x" }] }, 0, bySku);
  assert.equal(kept.relevant, true);
  assert.deepEqual(kept.affected.map((a) => a.sku), ["PLY-102"]);
  assert.equal(decide(timber, { relevant: true, affected: [{ sku: "NOPE-1", reason: "x" }] }, 0, bySku).relevant, false);
  assert.equal(decide(timber, { relevant: true, affected: [{ sku: "PLY-102", reason: "x" }], sameAs: 0 }, 1, bySku).duplicate, true);
  const cocoa = decide({ title: "Cocoa and EUDR", snippet: "" }, { relevant: true, affected: [{ sku: "PLY-101", reason: "x" }] }, 0, bySku);
  assert.deepEqual([cocoa.relevant, cocoa.otherCommodity], [false, true]);
});

const alert = (c, over) => ({ relevant: true, modelRelevant: true, affected: c.expect.skus, severity: c.expect.severity?.[0], direction: c.expect.direction?.[0], ...over });
const perfect = () => {
  const outcomes = new Map();
  for (const c of cases) outcomes.set(c.id, c.expect.relevant && c.id !== "eudr-date-repeat" ? alert(c) : { relevant: false, modelRelevant: false, affected: [] });
  return outcomes;
};

test("a perfect scan passes every case with full precision and recall", () => {
  const scored = scoreScanCases(cases, perfect());
  assert.ok(scored.every((s) => s.pass), scored.filter((s) => !s.pass).map((s) => s.id).join(", "));
  const m = summarizeScanRun(cases, scored);
  assert.deepEqual([m.relevance.precision, m.relevance.recall, m.skus.precision, m.skus.recall], [1, 1, 1, 1]);
  assert.equal(m.relevance.fp, 0);
});

test("scores false alarms, misses, wrong SKUs, severity and repeated events", () => {
  const outcomes = perfect();
  outcomes.set("shrimp-antidumping", { relevant: true, modelRelevant: true, affected: ["PLY-102"], severity: "low", direction: "risk" });
  outcomes.set("cocoa-eudr", { relevant: false, modelRelevant: true, otherCommodity: true, affected: [] });
  outcomes.set("us-232-cabinets", alert(byId("us-232-cabinets"), { affected: ["CAB-101", "FUR-101"], severity: "medium" }));
  outcomes.set("cameroon-sapele-suspension", { relevant: false, modelRelevant: false, affected: [] });
  outcomes.set("eudr-date-repeat", alert(byId("eudr-date-repeat")));
  const scored = scoreScanCases(cases, outcomes);
  const failed = (id) => scored.find((s) => s.id === id).checks.filter((x) => !x.ok).map((x) => x.name);

  assert.deepEqual(failed("shrimp-antidumping"), ["Relevance"]);
  assert.deepEqual(failed("cocoa-eudr"), []);
  assert.deepEqual(failed("us-232-cabinets"), ["Names the affected SKUs", "Names no unrelated SKUs", "Severity"]);
  assert.deepEqual(failed("cameroon-sapele-suspension"), ["Relevance"]);
  assert.deepEqual(failed("eudr-date"), ["Event kept once"]);

  const m = summarizeScanRun(cases, scored);
  assert.equal(m.relevance.fp, 1);
  assert.equal(m.relevance.fn, 1);
  assert.equal(m.overridden.otherCommodity, 1);
  assert.ok(m.skus.precision < 1 && m.skus.recall < 1);
  assert.ok(m.severityAgreement < 1);
});

test("a case missing from the model's answer fails as not assessed", () => {
  const outcomes = perfect();
  outcomes.delete("vn-gdp");
  const s = scoreScanCases(cases, outcomes).find((x) => x.id === "vn-gdp");
  assert.equal(s.pass, false);
  assert.equal(s.checks[0].name, "Assessed");
});

test("repeated runs pass a case only if every run passed, and flag unstable verdicts", () => {
  const good = scoreScanCases(cases, perfect());
  const outcomes = perfect();
  outcomes.set("upholstered-tariff-talk", { relevant: false, modelRelevant: false, affected: [] });
  const bad = scoreScanCases(cases, outcomes);
  const merged = mergeRepeats([good, bad, good]);
  const s = merged.find((x) => x.id === "upholstered-tariff-talk");
  assert.deepEqual([s.pass, s.passes, s.runs, s.stable], [false, 2, 3, false]);
  assert.ok(merged.find((x) => x.id === "vn-gdp").stable);
});

test("mentions are scored on their own: what the article names, for the knowledge graph", () => {
  const expected = byId("russia-birch-sanctions").expect.mentions;
  assert.deepEqual(expected, { materials: ["birch"], origins: ["RU"], markets: ["US", "EU"] });
  const all = scoreMentions(expected, { materials: ["birch veneer"], hsCodes: ["4408"], originCountries: ["RU"], markets: ["US", "EU"] });
  assert.deepEqual(all, { total: 4, found: 4, missing: [], extraOrigins: [] });
  const some = scoreMentions(expected, { materials: ["veneer"], originCountries: ["RU", "VN"], markets: ["EU"] });
  assert.deepEqual(some.missing, ["material birch", "market US"]);
  assert.deepEqual(some.extraOrigins, ["VN"]);
  // "GB" counts as the UK market; HS codes compare by heading.
  assert.equal(scoreMentions({ markets: ["UK"], headings: ["4401"] }, { markets: ["GB"], hsCodes: ["4401.31"] }).found, 2);

  // In a run: a relevant alert carries its mention score, outside pass/fail.
  const outcomes = new Map([["russia-birch-sanctions", { relevant: true, affected: ["HWP-101", "CAB-102"], severity: "high", direction: "risk", mentions: { materials: [], hsCodes: [], originCountries: ["RU"], markets: [] } }]]);
  const [scored] = scoreScanCases([byId("russia-birch-sanctions")], outcomes);
  assert.equal(scored.pass, true);
  assert.deepEqual(scored.mentions.missing, ["material birch", "market US", "market EU"]);
  assert.equal(summarizeScanRun([byId("russia-birch-sanctions")], [scored]).mentions.recall, 0.25);
});
