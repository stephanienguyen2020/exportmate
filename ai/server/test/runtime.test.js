import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chatInput, server } from "../runtime.js";

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
  assert.equal(turn.access.companyId, null);
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
