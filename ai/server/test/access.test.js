import { test } from "node:test";
import assert from "node:assert/strict";
import { ANONYMOUS, ageDays, auditVisible, presentScan, presentSources, publicAudit, scanRules, skipsOld, visibleItems } from "../access.js";

const sources = [
  { id: "builtin", name: "Timber news", builtIn: true, enabled: true },
  { id: "legacy", name: "Old custom feed", builtIn: false, enabled: true }, // added before owners
  { id: "a-feed", name: "A's feed", builtIn: false, enabled: true, companyId: "A" },
  { id: "b-feed", name: "B's feed", builtIn: false, enabled: true, companyId: "B" },
];
const companyA = { companyId: "A", disabled: [] };

test("a company sees shared sources and its own, never another company's", () => {
  assert.deepEqual(presentSources(sources, companyA).map((s) => s.id), ["builtin", "legacy", "a-feed"]);
  assert.deepEqual(presentSources(sources, ANONYMOUS).map((s) => s.id), ["builtin", "legacy"]);
  assert.ok(presentSources(sources, companyA).every((s) => !("companyId" in s)));
});

test("switching a shared source off applies to that company only", () => {
  const offForA = { companyId: "A", disabled: ["builtin"] };
  assert.equal(presentSources(sources, offForA).find((s) => s.id === "builtin").enabled, false);
  assert.equal(presentSources(sources, { companyId: "B", disabled: [] }).find((s) => s.id === "builtin").enabled, true);
});

test("alerts follow the visibility of the sources they came from", () => {
  const alerts = [
    { id: "1", sourceId: "builtin" },
    { id: "2", sourceIds: ["b-feed"] },
    { id: "3", sourceIds: ["b-feed", "builtin"] }, // also carried by a shared source
    { id: "4", sourceIds: ["gone"], sourceCompanyIds: ["B"] }, // B's source was deleted
    { id: "5", sourceIds: ["gone"], sourceCompanyIds: [null] },
    { id: "6" }, // from before sources were recorded
  ];
  assert.deepEqual(visibleItems(alerts, sources, companyA).map((a) => a.id), ["1", "3", "5", "6"]);
  assert.deepEqual(visibleItems(alerts, sources, { companyId: "A", disabled: ["builtin"] }).map((a) => a.id), ["5", "6"]);
  assert.deepEqual(visibleItems(alerts, sources, { companyId: "B", disabled: [] }).map((a) => a.id), ["1", "2", "3", "4", "5", "6"]);
});

test("index hits for a source document use its refId", () => {
  const hits = [
    { type: "source", refId: "b-feed" },
    { type: "source", refId: "a-feed" },
  ];
  assert.deepEqual(visibleItems(hits, sources, companyA).map((h) => h.refId), ["a-feed"]);
});

test("alerts and stock items are for whose goods they are about: a company's, or the demo's sample", () => {
  const records = [
    { id: "sample-alert", affected: [], sourceId: "builtin" },
    { id: "a-alert", affected: [], sourceId: "builtin", companyId: "A" },
    { id: "b-alert", affected: [], sourceId: "builtin", companyId: "B" },
    { id: "sample-item", type: "item", refId: "PLY-101" },
    { id: "a-alert-hit", type: "alert", sourceIds: ["builtin"], companyId: "A" },
    { id: "article", type: "article", sourceIds: ["builtin"] },
    { id: "guide", type: "guide" },
  ];
  assert.deepEqual(visibleItems(records, sources, companyA).map((r) => r.id), ["a-alert", "a-alert-hit", "article", "guide"]);
  assert.deepEqual(visibleItems(records, sources, ANONYMOUS).map((r) => r.id), ["sample-alert", "sample-item", "article", "guide"]);
  // A company alert still needs a source the company reads.
  assert.deepEqual(visibleItems(records, sources, { companyId: "A", disabled: ["builtin"] }).map((r) => r.id), ["guide"]);
});

test("company audits need that company; raw reasoning never leaves the server", () => {
  assert.ok(auditVisible({ companyId: undefined }, ANONYMOUS));
  assert.ok(!auditVisible({ companyId: "B" }, companyA));
  assert.ok(!auditVisible({ companyId: "B" }, ANONYMOUS));
  assert.ok(auditVisible({ companyId: "A" }, companyA));
  const shown = publicAudit({ id: "x", steps: [{ kind: "plan", thought: "secret", note: "n" }, { kind: "tool" }] });
  assert.deepEqual(shown.steps, [{ kind: "plan", note: "n" }, { kind: "tool" }]);
});

test("alerts from articles older than the age rule when scanned show only to companies that switched it off", () => {
  const alerts = [
    { id: "recent", sourceIds: ["builtin"], ageDays: 3 },
    { id: "old", sourceIds: ["builtin"], ageDays: 400 },
    { id: "undated", sourceIds: ["builtin"], ageDays: null },
    { id: "before-rule", sourceIds: ["builtin"] },
  ];
  const ids = (access, maxAgeDays) => visibleItems(alerts, sources, access, maxAgeDays).map((a) => a.id);
  assert.deepEqual(ids(companyA, 365), ["recent", "undated", "before-rule"]);
  assert.deepEqual(ids(ANONYMOUS, 365), ["recent", "undated", "before-rule"]);
  assert.deepEqual(ids({ ...companyA, skipOld: false }, 365), ["recent", "old", "undated", "before-rule"]);
  assert.deepEqual(ids(companyA, 0), ["recent", "old", "undated", "before-rule"]); // no rule configured
});

test("the age rule is on unless a company switches it off, and absent when not configured", () => {
  assert.ok(skipsOld(ANONYMOUS, 365));
  assert.ok(!skipsOld({ ...companyA, skipOld: false }, 365));
  assert.deepEqual(scanRules(companyA, 365), { maxAgeDays: 365, skipOld: true });
  assert.deepEqual(scanRules({ ...companyA, skipOld: false }, 365), { maxAgeDays: 365, skipOld: false });
  assert.equal(scanRules(companyA, 0), null);
});

test("an article's age is whole days before the scan, null when undated", () => {
  const at = Date.parse("2026-10-15T12:00:00Z");
  assert.equal(ageDays("2026-10-14T13:00:00Z", at), 0);
  assert.equal(ageDays("2025-10-14T12:00:00Z", at), 366);
  assert.equal(ageDays(null, at), null);
  assert.equal(ageDays("not a date", at), null);
});

test("a scan shows each caller its own alert count and only the sources it can see", () => {
  const scan = {
    impactsFound: 3,
    companyImpacts: { A: 2 },
    sources: [
      { id: "builtin", name: "Timber news", companyId: null, ok: true, count: 9 },
      { id: "a-feed", name: "A's feed", companyId: "A", ok: true, count: 20 },
    ],
  };
  const forA = presentScan(scan, companyA);
  assert.equal(forA.impactsFound, 2);
  assert.equal(forA.companyImpacts, undefined);
  assert.deepEqual(forA.sources.map((s) => s.id), ["builtin", "a-feed"]);
  assert.ok(forA.sources.every((s) => !("companyId" in s)));
  assert.deepEqual(presentScan(scan, { companyId: "B", disabled: [] }).sources.map((s) => s.id), ["builtin"]);
  const demo = presentScan(scan, ANONYMOUS);
  assert.equal(demo.impactsFound, 3);
  assert.deepEqual(demo.sources.map((s) => s.id), ["builtin"]);
  assert.equal(scan.sources.length, 2, "the stored record is unchanged");
});
