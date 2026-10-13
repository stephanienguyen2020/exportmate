import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readJson, scanBlocked } from "../limits.js";

const body = (...chunks) => Readable.from(chunks.map((c) => Buffer.from(c)));

test("reads a JSON body", async () => {
  assert.deepEqual(await readJson(body('{"a":', "1}")), { a: 1 });
  assert.deepEqual(await readJson(body()), {});
});

test("rejects bad JSON with 400 and oversized bodies with 413", async () => {
  await assert.rejects(readJson(body("{nope")), (e) => e.status === 400);
  await assert.rejects(readJson(body("x".repeat(60), "y".repeat(60)), 100), (e) => e.status === 413);
});

test("scan lock: one scan at a time, cooldown for manual scans", () => {
  const now = Date.parse("2026-10-13T08:00:00Z");
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
  assert.equal(scanBlocked(undefined, { scheduled: false, now }), null);
  assert.deepEqual(scanBlocked({ startedAt: ago(2), running: true }, { scheduled: true, now }), [409, "A scan is already running."]);
  assert.deepEqual(scanBlocked({ startedAt: ago(2), running: true }, { scheduled: false, now }), [429, "A scan is already running."]);
  assert.deepEqual(scanBlocked({ startedAt: ago(2), running: false }, { scheduled: false, now }), [429, "A scan ran in the last 10 minutes."]);
  assert.equal(scanBlocked({ startedAt: ago(2), running: false }, { scheduled: true, now }), null);
  // A lock left "running" by a crashed scan expires with the cooldown.
  assert.equal(scanBlocked({ startedAt: ago(11), running: true }, { scheduled: false, now }), null);
});
