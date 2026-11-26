import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chatInput, server } from "../runtime.js";
import { DEMO_COMPANY_ID } from "../access.js";
import { startTracing, traceResource } from "../agents/telemetry.js";

const listening = new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
after(() => server.close());
const post = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:${await listening}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test("serves the runtime contract's routes and refuses undeclared methods", async () => {
  assert.equal((await post("/api/reasoning_engine", { class_method: "drop_tables", input: {} })).status, 400);
  assert.equal((await post("/api/stream_reasoning_engine", { class_method: "query", input: {} })).status, 400);
  assert.equal((await post("/api/elsewhere", { class_method: "query", input: {} })).status, 404);
  const bad = await post("/api/reasoning_engine", { class_method: "query", input: { messages: [] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /messages and a sessionId/);
  const health = await fetch(`http://127.0.0.1:${await listening}/`);
  assert.equal(health.status, 200);
});

test("the console playground's message runs as the demo", () => {
  const turn = chatInput({ message: "Which items have no geolocation?", user_id: "someone", session_id: "abc" });
  assert.deepEqual(turn.messages, [{ role: "user", text: "Which items have no geolocation?" }]);
  assert.match(turn.sessionId, /^playground-/); // "abc" is not a valid session id
  assert.equal(turn.company, undefined);
  assert.equal(turn.access.companyId, DEMO_COMPANY_ID);
});

test("the user's backend token only reaches the backend reader, never the turn's data", () => {
  const turn = chatInput({
    messages: [{ role: "user", text: "Status of PO-2291?" }],
    sessionId: "session-1234",
    company: { company: { id: "co-1" } },
    user: { id: "u-1" },
    backendToken: "secret-token-value",
  });
  assert.equal(typeof turn.backend, "function");
  assert.doesNotMatch(JSON.stringify(turn), /secret-token-value/);
  // Without a company there is no backend to read.
  assert.equal(chatInput({ messages: [{ role: "user", text: "hi" }], sessionId: "session-1234", backendToken: "x" }).backend, null);
});

test("the agents check the browser demo's orders and rules themselves; a company chat ignores them", () => {
  const sent = {
    orders: [
      { id: "PO-1", value: 1200, shipDate: "2026-12-01", status: "exposed", check: { title: "EUDR (sample rule)", status: "missing", note: "No geolocation" } },
      { id: "", value: -1 },
    ],
    rules: [{ id: "r1", category: "Policy", text: "Hold EU orders without geolocation", enabled: true }],
  };
  const demo = chatInput({ messages: [{ role: "user", text: "hi" }], sessionId: "session-1234", demo: sent }).demo;
  assert.deepEqual(demo.orders.map((o) => [o.id, o.checks.map((c) => c.status)]), [["PO-1", ["missing"]]]);
  assert.deepEqual(demo.playbook.map((r) => r.text), ["Hold EU orders without geolocation"]);
  const company = chatInput({ messages: [{ role: "user", text: "hi" }], sessionId: "session-1234", company: { company: { id: "co-1" } }, demo: sent });
  assert.equal(company.demo, null);
});

test("traces are filed under the Agent Runtime instance, and only there", () => {
  const resource = traceResource({ project: "exportmate-app", location: "asia-southeast1", id: "7999914662302842880" });
  assert.equal(resource["cloud.platform"], "gcp.agent_engine");
  assert.equal(resource["cloud.resource_id"], "//aiplatform.googleapis.com/projects/exportmate-app/locations/asia-southeast1/reasoningEngines/7999914662302842880");
  assert.equal(resource["service.name"], "7999914662302842880");
  assert.equal(startTracing(), false); // no AGENT_RUNTIME in tests
});
