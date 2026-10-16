import { test } from "node:test";
import assert from "node:assert/strict";
import { answerKey, cacheable, cachedAudit, fingerprint, normalizeText, stableJson } from "../answer-cache.js";

const base = {
  messages: [{ role: "user", text: "Who supplies PLY-101?" }],
  companyId: null,
  disabled: [],
  dataVersion: "d1",
  policyVersion: "p1",
  models: { simple: "s", complex: "c" },
  day: "2026-10-14",
};

test("the same question, written differently, has one key", () => {
  assert.equal(normalizeText("  Who  supplies PLY-101?? "), "who supplies ply-101");
  assert.equal(answerKey(base), answerKey({ ...base, messages: [{ role: "user", text: "who supplies   ply-101" }] }));
  assert.equal(normalizeText("Chúng ta có bao nhiêu mặt hàng？"), "chúng ta có bao nhiêu mặt hàng");
});

test("anything the answer depends on changes the key", () => {
  const key = answerKey(base);
  for (const change of [
    { messages: [{ role: "user", text: "Who supplies PLY-102?" }] },
    { companyId: "co-1" },
    { disabled: ["src-1"] },
    { skipOld: false },
    { dataVersion: "d2" },
    { policyVersion: "p2" },
    { models: { simple: "s2", complex: "c" } },
    { day: "2026-10-15" },
    { messages: [{ role: "user", text: "Hi" }, { role: "model", text: "Hello" }, { role: "user", text: "Who supplies PLY-101?" }] },
  ])
    assert.notEqual(answerKey({ ...base, ...change }), key, JSON.stringify(change));
  assert.equal(answerKey({ ...base, disabled: ["b", "a"] }), answerKey({ ...base, disabled: ["a", "b"] }));
  // The age rule on (the default) keeps the keys answers were cached under before it existed.
  assert.equal(answerKey({ ...base, skipOld: true }), key);
});

test("fingerprints ignore key order", () => {
  assert.equal(stableJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
});

test("only clean answers are cached", () => {
  const ok = { status: "ok", answer: "A", checks: [{ ok: true }], steps: [{ kind: "tool" }] };
  assert.equal(cacheable(ok), true);
  assert.equal(cacheable({ ...ok, status: "needs_review" }), false);
  assert.equal(cacheable({ ...ok, answer: "" }), false);
  assert.equal(cacheable({ ...ok, checks: [{ ok: false }] }), false);
  assert.equal(cacheable({ ...ok, steps: [{ kind: "tool", error: "timeout" }] }), false);
});

test("a cached turn names the original and uses no model", () => {
  const original = {
    id: "a1",
    createdAt: "2026-10-14T01:00:00.000Z",
    model: "m",
    embeddingModel: "e",
    policyVersion: "p1",
    route: { tier: "simple", reasons: [] },
    steps: [{ at: 5, kind: "answer" }],
    usage: { promptTokens: 900, outputTokens: 100, thinkingTokens: 0, modelCalls: 2 },
    answer: "An Phat [1]",
    checks: [{ ok: true }],
    citations: [{ ref: 1 }],
    retrieved: [{ ref: 1 }],
    sessionId: "other-session",
  };
  const a = cachedAudit(original, { sessionId: "s2", requestId: "r2", channel: "chat", companyId: undefined, question: "who supplies ply-101", startedAt: Date.parse("2026-10-14T02:00:00Z"), latencyMs: 40 });
  assert.equal(a.sessionId, "s2");
  assert.equal(a.answer, original.answer);
  assert.deepEqual(a.cache, { auditId: "a1", answeredAt: original.createdAt });
  assert.deepEqual(a.steps[0], { at: 0, kind: "cache", auditId: "a1", answeredAt: original.createdAt });
  assert.equal(a.steps.length, 2);
  assert.equal(a.usage.modelCalls, 0);
  assert.equal(a.createdAt, "2026-10-14T02:00:00.000Z");
});
