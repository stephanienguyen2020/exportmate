// Property-based tests (fast-check): rules that must hold for every input, not just examples.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import fc from "fast-check";
import { evaluate } from "../calc.js";
import { readJson, scanBlocked, SCAN_COOLDOWN_MS } from "../limits.js";

// --- calculate tool ---------------------------------------------------------------------------

// Expression trees, rendered to text and computed directly with the same float operations.
const { tree } = fc.letrec((tie) => ({
  tree: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    tie("leaf"),
    tie("neg"),
    tie("paren"),
    tie("binary"),
  ),
  leaf: fc.oneof(fc.nat({ max: 100_000 }), fc.integer({ min: 0, max: 99_999 }).map((n) => n / 100)).map((n) => ({ n })),
  neg: tie("tree").map((x) => ({ neg: x })),
  paren: tie("tree").map((x) => ({ paren: x })),
  binary: fc.record({ op: fc.constantFrom("+", "-", "*", "/"), a: tie("tree"), b: tie("tree") }),
}));

// Precedence-correct rendering: operands are wrapped in parentheses, so the text means the tree.
const text = (t, space) => {
  if ("n" in t) return String(t.n);
  if ("neg" in t) return `-(${text(t.neg, space)})`;
  if ("paren" in t) return `(${text(t.paren, space)})`;
  return `(${text(t.a, space)})${space}${t.op}${space}(${text(t.b, space)})`;
};
const value = (t) => {
  if ("n" in t) return t.n;
  if ("neg" in t) return -value(t.neg);
  if ("paren" in t) return value(t.paren);
  const a = value(t.a);
  const b = value(t.b);
  if (t.op === "/" && b === 0) throw new Error("Division by zero");
  return t.op === "+" ? a + b : t.op === "-" ? a - b : t.op === "*" ? a * b : a / b;
};
const outcome = (f) => {
  try {
    return { value: f() };
  } catch (e) {
    return { error: e.message };
  }
};

test("calculate agrees with direct arithmetic on every expression it accepts", () => {
  fc.assert(
    fc.property(tree, fc.constantFrom("", " ", "\t"), (t, space) => {
      const source = text(t, space);
      fc.pre(source.length <= 300);
      const expected = outcome(() => Math.round(value(t) * 100) / 100);
      assert.deepEqual(outcome(() => evaluate(source)), expected, source);
    }),
  );
});

test("calculate refuses any text with a character outside numbers and + - * / ( )", () => {
  const junk = fc.string({ minLength: 1 }).filter((s) => /[^\d\s+\-*/().,]/.test(s));
  fc.assert(
    fc.property(junk, (s) => {
      assert.throws(() => evaluate(s), /Use only numbers/);
    }),
  );
});

test("calculate ignores thousands separators", () => {
  fc.assert(
    fc.property(fc.nat({ max: 10 ** 12 }), (n) => {
      assert.equal(evaluate(n.toLocaleString("en-US")), n);
    }),
  );
});

test("calculate either answers or throws an Error, whatever the text", () => {
  fc.assert(
    fc.property(fc.string({ unit: fc.constantFrom(..."0123456789+-*/(). ,") }), (s) => {
      const result = outcome(() => evaluate(s));
      if ("value" in result) assert.equal(typeof result.value, "number");
      else assert.equal(typeof result.error, "string");
    }),
  );
});

// --- scan lock --------------------------------------------------------------------------------

const now = Date.parse("2026-10-13T08:00:00Z");
const lock = fc.option(
  fc.record({
    startedAt: fc.integer({ min: 0, max: 3 * SCAN_COOLDOWN_MS }).map((ago) => new Date(now - ago).toISOString()),
    running: fc.boolean(),
  }),
  { nil: undefined },
);

test("scan lock: the decision table for every lock state", () => {
  fc.assert(
    fc.property(lock, fc.boolean(), (l, scheduled) => {
      const refusal = scanBlocked(l, { scheduled, now });
      const recent = l && now - Date.parse(l.startedAt) < SCAN_COOLDOWN_MS;
      if (!recent) return assert.equal(refusal, null); // no lock, or one past the cooldown
      if (l.running) return assert.deepEqual(refusal, [scheduled ? 409 : 429, "A scan is already running."]);
      assert.deepEqual(refusal, scheduled ? null : [429, "A scan ran in the last 10 minutes."]);
    }),
  );
});

test("scan lock: a manual scan is never let in where a scheduled one is refused", () => {
  fc.assert(
    fc.property(lock, (l) => {
      if (scanBlocked(l, { scheduled: true, now })) assert.notEqual(scanBlocked(l, { scheduled: false, now }), null);
    }),
  );
});

// --- request bodies ---------------------------------------------------------------------------

const chunks = fc.array(fc.string({ maxLength: 40 }), { maxLength: 12 });

test("readJson keeps a body up to the limit and refuses one past it with 413", async () => {
  await fc.assert(
    fc.asyncProperty(chunks, fc.integer({ min: 1, max: 300 }), async (parts, max) => {
      const json = JSON.stringify(parts.join(""));
      // Split the JSON text at the same points as the generated parts.
      const pieces = [];
      for (let i = 0, at = 0; i < parts.length; at += parts[i].length, i++) pieces.push(json.slice(at, at + parts[i].length));
      pieces.push(json.slice(pieces.join("").length));
      const req = Readable.from(pieces.filter(Boolean).map((p) => Buffer.from(p)));
      const size = Buffer.byteLength(json);
      if (size <= max) assert.equal(await readJson(req, max), parts.join(""));
      else await assert.rejects(readJson(req, max), (e) => e.status === 413);
    }),
  );
});
