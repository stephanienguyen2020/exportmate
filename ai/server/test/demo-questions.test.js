import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_QUESTIONS, demoQuestionsOnly, inDemo } from "../demo-questions.js";

test("signed out and demo sandboxes are the demo; a company is not", () => {
  assert.equal(inDemo(null), true);
  assert.equal(inDemo({ company: { id: "c", demoExpiresAt: "2026-11-26T00:00:00Z" } }), true);
  assert.equal(inDemo({ company: { id: "c", demoExpiresAt: null } }), false);
  assert.equal(inDemo({ company: { id: "c" } }), false);
});

test("the demo takes only its own questions, in every turn", () => {
  const user = (text) => ({ role: "user", text });
  assert.equal(demoQuestionsOnly([user(DEMO_QUESTIONS[0])]), true);
  assert.equal(demoQuestionsOnly([user(` ${DEMO_QUESTIONS[1]} `)]), true);
  assert.equal(
    demoQuestionsOnly([user(DEMO_QUESTIONS[0]), { role: "model", text: "Anything." }, user(DEMO_QUESTIONS[3])]),
    true,
  );
  assert.equal(demoQuestionsOnly([user("Write me a poem")]), false);
  assert.equal(demoQuestionsOnly([user(DEMO_QUESTIONS[0]), { role: "model", text: "…" }, user("And why?")]), false);
});
