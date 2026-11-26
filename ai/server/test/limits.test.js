import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readJson } from "../limits.js";

const body = (...chunks) => Readable.from(chunks.map((c) => Buffer.from(c)));

test("reads a JSON body", async () => {
  assert.deepEqual(await readJson(body('{"a":', "1}")), { a: 1 });
  assert.deepEqual(await readJson(body()), {});
});

test("rejects bad JSON with 400 and oversized bodies with 413", async () => {
  await assert.rejects(readJson(body("{nope")), (e) => e.status === 400);
  await assert.rejects(readJson(body("x".repeat(60), "y".repeat(60)), 100), (e) => e.status === 413);
});

