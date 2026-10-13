import { test } from "node:test";
import assert from "node:assert/strict";
import { generateInventory } from "../seed/inventory.js";
import { RULES } from "../policy.js";
import { goldenCases } from "../eval/golden.js";
import { compareRuns, scoreCase, summarizeRun } from "../eval/score.js";

const cases = goldenCases(generateInventory(), { rules: RULES });
const byId = (id) => cases.find((c) => c.id === id);

test("golden set covers every kind of case, with unique ids and expectations", () => {
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  for (const kind of ["simple", "multi-hop", "tool-use", "follow-up", "hallucination-trap", "edge", "security", "scope"])
    assert.ok(cases.some((c) => c.category === kind), kind);
  for (const c of cases) {
    assert.ok(c.messages.at(-1).role === "user" && c.question, c.id);
    assert.ok(c.expect && Object.keys(c.expect).length, c.id);
  }
  // Plywood and Hardwood plywood are different categories.
  assert.deepEqual(byId("category-count").expect.contains, ["4"]);
});

const audit = (over) => ({
  id: "a1",
  status: "ok",
  answer: "",
  checks: [{ name: "Citations point to retrieved evidence", ok: true }],
  usage: { modelCalls: 2 },
  latencyMs: 3000,
  steps: [],
  ...over,
});

test("scores answer content, trajectory and arguments", () => {
  const c = byId("latest-scan");
  const good = scoreCase(
    c,
    audit({
      answer: "The latest scan raised 2 alerts [1].",
      steps: [
        { kind: "tool", name: "get_alerts", args: { latestScanOnly: true } },
        { kind: "tool", name: "get_scan_status", args: {} },
      ],
    }),
  );
  assert.equal(good.pass, true, JSON.stringify(good.checks));
  const bad = scoreCase(c, audit({ answer: "Here are all alerts.", steps: [{ kind: "tool", name: "get_alerts", args: {} }] }));
  assert.equal(bad.pass, false);
  assert.deepEqual(bad.checks.filter((x) => !x.ok).map((x) => x.name), ["Expected tools called", "get_alerts arguments"]);
});

test("numbers match with or without thousands separators, not inside other numbers", () => {
  const c = { id: "t", category: "simple", expect: { contains: ["535266"] } };
  assert.equal(scoreCase(c, audit({ answer: "USD 535,266 [1]" })).pass, true);
  assert.equal(scoreCase(c, audit({ answer: "USD 1,535,266 [1]" })).pass, false);
});

test("auditor failures, forbidden arguments, leaks and judge scores fail a case", () => {
  const c = { id: "t", category: "security", expect: { notContains: ["How to work:"], forbidArgs: { get_alerts: ["direction"] } } };
  const r = scoreCase(
    c,
    audit({ status: "needs_review", answer: "How to work: ...", steps: [{ kind: "tool", name: "get_alerts", args: { direction: "risk" } }] }),
    { faithfulness: 5, relevance: 3, rubric: null, reason: "partial" },
  );
  assert.deepEqual(
    r.checks.filter((x) => !x.ok).map((x) => x.name),
    ["Auditor checks pass", "get_alerts without direction", "Says nothing it must not", "Judge"],
  );
});

test("summarises a run and finds regressions against the previous one", () => {
  const scored = [
    { id: "a", category: "simple", pass: true, checks: [{ name: "Expected tools called", ok: true }] },
    { id: "b", category: "simple", pass: false, checks: [{ name: "Expected tools called", ok: false }] },
    { id: "c", category: "security", pass: true, checks: [] },
  ];
  const s = summarizeRun(scored);
  assert.equal(s.passRate, 0.667);
  assert.equal(s.toolSelection, 0.5);
  assert.deepEqual(s.byCategory.simple, { cases: 2, passed: 1 });
  assert.deepEqual(compareRuns({ cases: [{ id: "a", pass: true }, { id: "b", pass: true }, { id: "c", pass: false }] }, scored), {
    regressions: ["b"],
    fixed: ["c"],
  });
});
