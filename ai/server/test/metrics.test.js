import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeAudits } from "../metrics.js";

test("summarises outcomes, latency, tools and guard activity", () => {
  const audits = [
    {
      status: "ok",
      latencyMs: 4000,
      policyVersion: "p1",
      model: "m",
      usage: { modelCalls: 3, promptTokens: 900, outputTokens: 100 },
      checks: [{ name: "Citations point to retrieved evidence", ok: true }],
      citations: [{}, {}],
      steps: [{ kind: "tool", name: "query_inventory" }, { kind: "tool", name: "get_alerts", error: "x", errorKind: "timeout", attempts: 2, flags: [{}] }],
      flags: [{ where: "alert a" }],
    },
    {
      status: "needs_review",
      latencyMs: 9000,
      policyVersion: "p2",
      model: "m",
      usage: { modelCalls: 5, promptTokens: 1100, outputTokens: 300 },
      checks: [{ name: "Citations point to retrieved evidence", ok: false }],
      citations: [],
      steps: [{ kind: "review" }, { kind: "tool", name: "query_inventory" }],
    },
  ];
  const s = summarizeAudits(audits);
  assert.equal(s.audits, 2);
  assert.deepEqual(s.status, { ok: 1, needs_review: 1 });
  assert.equal(s.passRate, 0.5);
  assert.equal(s.revisionRate, 0.5);
  assert.deepEqual(s.checks["Citations point to retrieved evidence"], { passed: 1, failed: 1 });
  assert.equal(s.latencyMs.p95, 9000);
  assert.equal(s.perAnswer.promptTokens, 1000);
  assert.equal(s.toolErrorRate, 0.333);
  assert.deepEqual(s.tools.get_alerts, { calls: 1, errors: 1, retried: 1, errorKinds: { timeout: 1 } });
  assert.equal(s.withheldPassages, 1);
  assert.deepEqual(s.policyVersions, { p1: 1, p2: 1 });
  assert.equal(summarizeAudits([]).passRate, 0);
});
