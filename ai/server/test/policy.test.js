import { test } from "node:test";
import assert from "node:assert/strict";
import { POLICY_VERSION, RULES, rulesFor, version } from "../policy.js";

test("every rule traces to the failure it prevents (ratchet)", () => {
  const ids = new Set();
  for (const r of RULES) {
    assert.match(r.id, /^[a-z-]+$/);
    assert.ok(!ids.has(r.id), `duplicate rule ${r.id}`);
    ids.add(r.id);
    assert.ok(r.text.length > 20, r.id);
    assert.ok(r.prevents?.length > 10, `${r.id} must say which failure it prevents`);
  }
});

test("company-only rules apply only in a company workspace", () => {
  assert.ok(!rulesFor(null).some((r) => r.id === "company-profile"));
  assert.ok(rulesFor({ company: {} }).some((r) => r.id === "company-profile"));
});

test("the policy version changes with the rules", () => {
  assert.match(POLICY_VERSION, /^[0-9a-f]{10}$/);
  assert.equal(version(RULES), POLICY_VERSION);
  assert.notEqual(version([...RULES, { id: "x", text: "new rule", prevents: "x" }]), POLICY_VERSION);
});
