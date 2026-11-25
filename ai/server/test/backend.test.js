import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearStatusLabels, orderStatusLabels } from "../backend.js";

const answer = (data, ok = true) => async () => ({ ok, json: async () => ({ data }) });
const STATUSES = [{ code: "exposed", label: "Action needed" }, { code: "clear", label: "Ready to ship" }];

beforeEach(clearStatusLabels);

test("order statuses are worded as the backend's database names them", async () => {
  const labels = await orderStatusLabels({ fetchImpl: answer(STATUSES) });
  assert.deepEqual(labels, { exposed: "Action needed", clear: "Ready to ship" });
});

test("the statuses are kept for ten minutes, then read again", async () => {
  let reads = 0;
  const fetchImpl = async (...args) => (reads++, answer(STATUSES)(...args));
  await orderStatusLabels({ now: 0, fetchImpl });
  await orderStatusLabels({ now: 9 * 60_000, fetchImpl });
  assert.equal(reads, 1);
  await orderStatusLabels({ now: 11 * 60_000, fetchImpl });
  assert.equal(reads, 2);
});

test("without the backend, statuses have no labels (shown by code) and the last ones are kept", async () => {
  const down = async () => { throw new Error("ECONNREFUSED"); };
  assert.deepEqual(await orderStatusLabels({ fetchImpl: down }), {});
  assert.deepEqual(await orderStatusLabels({ fetchImpl: answer([], false) }), {});
  await orderStatusLabels({ now: 0, fetchImpl: answer(STATUSES) });
  assert.equal((await orderStatusLabels({ now: 11 * 60_000, fetchImpl: down })).clear, "Ready to ship");
});
