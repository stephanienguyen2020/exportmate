import { test } from "node:test";
import assert from "node:assert/strict";
import { ANONYMOUS_WORKSPACE, turnWorkspace } from "../workspace.js";

const company = { company: { id: "co-1" } };
const demo = { orders: [{ order: { id: "PO-1" } }], playbook: null };

test("a company turn reads the company, never the demo's orders the client sent", () => {
  const backend = async () => ({ status: 200, body: {} });
  const w = turnWorkspace({ company, user: { id: "u-1" }, backend, demo });
  assert.equal(w.kind, "company");
  assert.equal(w.demo, undefined);
  assert.equal(w.backend, backend);
  assert.deepEqual(w.access, { companyId: "co-1", disabled: [] }, "no sources switched off by default");
});

test("the demo's orders make a demo turn; without them the turn is anonymous", () => {
  const w = turnWorkspace({ demo, backend: async () => ({}) });
  assert.equal(w.kind, "demo");
  assert.equal(w.backend, undefined, "no company, so no backend to read");
  assert.equal(w.access.companyId, null);
  assert.equal(turnWorkspace({ demo: { orders: null, playbook: null } }), ANONYMOUS_WORKSPACE);
  assert.equal(turnWorkspace(), ANONYMOUS_WORKSPACE);
});
