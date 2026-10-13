import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../calc.js";

test("evaluates with precedence, parentheses and thousands separators", () => {
  assert.equal(evaluate("2 + 3 * 4"), 14);
  assert.equal(evaluate("(535266 + 161128) / 2"), 348197);
  assert.equal(evaluate("1,000 - 250.5"), 749.5);
  assert.equal(evaluate("-(2 - 5)"), 3);
  assert.equal(evaluate("10 / 3"), 3.33);
});

test("rejects anything that is not arithmetic", () => {
  assert.throws(() => evaluate("process.exit()"), /Use only numbers/);
  assert.throws(() => evaluate("1 / 0"), /Division by zero/);
  assert.throws(() => evaluate("(1 + 2"), /Missing \)/);
  assert.throws(() => evaluate(""), /Use only numbers/);
});

test("tabs and line breaks count as spaces", () => {
  assert.equal(evaluate("1\t+\n2"), 3);
});
