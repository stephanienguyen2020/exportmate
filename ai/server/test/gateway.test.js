import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransient, toolGateway, validateArgs, withRetry } from "../gateway.js";

const schema = {
  type: "OBJECT",
  properties: {
    query: { type: "STRING" },
    limit: { type: "INTEGER" },
    skus: { type: "ARRAY", items: { type: "STRING" } },
    sort: { type: "STRING", enum: ["sku", "value"] },
    flag: { type: "BOOLEAN" },
  },
  required: ["query"],
};

test("validateArgs accepts well-formed arguments", () => {
  assert.deepEqual(validateArgs(schema, { query: "plywood", limit: 5, skus: ["PLY-101"], sort: "sku", flag: false }), []);
  assert.deepEqual(validateArgs(schema, { query: "x", limit: null }), []);
  assert.deepEqual(validateArgs(undefined, {}), []);
});

test("validateArgs reports wrong types, unknown keys, enums and missing required", () => {
  const problems = validateArgs(schema, { limit: 2.5, skus: "PLY-101", sort: "price", flag: "yes", extra: 1 });
  assert.ok(problems.includes("query is required"));
  assert.ok(problems.includes("limit must be a whole number"));
  assert.ok(problems.includes("skus must be a list"));
  assert.ok(problems.some((p) => p.startsWith("sort must be one of")));
  assert.ok(problems.includes("flag must be true or false"));
  assert.ok(problems.includes("unknown argument extra"));
  assert.deepEqual(validateArgs(undefined, { a: 1 }), ["this tool takes no arguments"]);
  assert.deepEqual(validateArgs(schema, { query: "x", skus: [1] }), ["skus[0] must be a string"]);
});

test("isTransient retries only temporary failures", () => {
  assert.ok(isTransient({ status: 429 }));
  assert.ok(isTransient({ status: 503 }));
  assert.ok(isTransient({ code: 14, message: "14 UNAVAILABLE" }));
  assert.ok(isTransient({ name: "TimeoutError" }));
  assert.ok(isTransient(new Error("fetch failed")));
  for (const status of [400, 401, 403, 404]) assert.equal(isTransient({ status }), false);
  assert.equal(isTransient(new Error("query is required")), false);
});

test("withRetry retries transient errors with backoff and gives up on others", async () => {
  const delays = [];
  const sleep = async (ms) => delays.push(ms);
  let calls = 0;
  const value = await withRetry(
    async () => {
      if (++calls < 3) throw Object.assign(new Error("busy"), { status: 503 });
      return "ok";
    },
    { retries: 2, baseMs: 100, sleep },
  );
  assert.equal(value, "ok");
  assert.deepEqual(delays, [100, 200]);

  calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw Object.assign(new Error("bad request"), { status: 400 });
    }, { sleep }),
    /bad request/,
  );
  assert.equal(calls, 1);
});

const registry = {
  search: { scope: "public", declaration: { name: "search", parameters: schema }, run: async (args) => ({ output: { got: args.query }, audit: { count: 1 } }) },
  profile: { scope: "company", declaration: { name: "profile" }, run: async () => ({ output: {}, audit: {} }) },
  flaky: {
    scope: "public",
    declaration: { name: "flaky" },
    run: (() => {
      let n = 0;
      return async () => {
        if (++n === 1) throw Object.assign(new Error("unavailable"), { code: 14 });
        return { output: { n }, audit: {} };
      };
    })(),
  },
  slow: { scope: "public", timeoutMs: 20, declaration: { name: "slow" }, run: () => new Promise(() => {}) },
};
const sleep = async () => {};

test("gateway offers and allows company tools only in a company session", async () => {
  const demo = toolGateway(registry, { company: null }, { sleep });
  assert.deepEqual(demo.declarations().map((d) => d.name), ["search", "flaky", "slow"]);
  const denied = await demo.call("profile", {});
  assert.equal(denied.ok, false);
  assert.equal(denied.errorKind, "denied");
  const company = toolGateway(registry, { company: { company: { id: "c1" } } }, { sleep });
  assert.ok(company.declarations().some((d) => d.name === "profile"));
  assert.equal((await company.call("profile", {})).ok, true);
});

test("gateway validates arguments before running the tool", async () => {
  const gw = toolGateway(registry, {}, { sleep });
  const bad = await gw.call("search", { limit: "5" });
  assert.equal(bad.errorKind, "invalid_args");
  assert.match(bad.error, /query is required/);
  const good = await gw.call("search", { query: "eudr" });
  assert.deepEqual(good.output, { got: "eudr" });
  assert.equal((await gw.call("delete_everything", {})).errorKind, "unknown_tool");
  assert.equal((await gw.call("constructor", {})).errorKind, "unknown_tool");
});

test("gateway retries transient failures, times out hung tools and enforces the budget", async () => {
  const gw = toolGateway(registry, {}, { sleep, maxCalls: 3, retries: 1 });
  const flaky = await gw.call("flaky", {});
  assert.equal(flaky.ok, true);
  assert.equal(flaky.attempts, 2);
  const slow = await gw.call("slow", {});
  assert.equal(slow.errorKind, "timeout");
  assert.equal(slow.attempts, 2);
  await gw.call("search", { query: "a" });
  const over = await gw.call("search", { query: "b" });
  assert.equal(over.errorKind, "budget");
});
