import { test } from "node:test";
import assert from "node:assert/strict";
import { thinkingConfig } from "../models.js";

test("Gemini 2.x models get no thinking level; newer models get the one asked for", () => {
  // gemini-2.5-flash answers 400 "thinking_level is not supported by this model" to a level.
  assert.deepEqual(thinkingConfig("gemini-2.5-flash", "MEDIUM"), {});
  assert.deepEqual(thinkingConfig("gemini-2.5-flash-lite", "LOW", { includeThoughts: true }), { includeThoughts: true });
  assert.deepEqual(thinkingConfig("gemini-3.5-flash", "MEDIUM"), { thinkingLevel: "MEDIUM" });
  assert.deepEqual(thinkingConfig("gemini-4-argon", "MEDIUM", { includeThoughts: true }), { thinkingLevel: "MEDIUM", includeThoughts: true });
});
