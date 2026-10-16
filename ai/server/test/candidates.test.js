import { test } from "node:test";
import assert from "node:assert/strict";
import { articleId, collectCandidates, errorText } from "../candidates.js";

const at = Date.parse("2026-10-15T00:00:00Z");
const daysAgo = (n) => new Date(at - n * 86_400_000).toISOString();
const article = (url, publishedAt) => ({ title: url, url: `https://news.example/${url}`, publishedAt, snippet: "", publisher: "" });
const shared = { id: "shared", name: "Timber news", builtIn: true, enabled: true };
const aFeed = { id: "a-feed", name: "A's feed", builtIn: false, enabled: true, companyId: "A" };
const ok = (...items) => ({ status: "fulfilled", value: items });

test("the age rule skips articles published more than maxAgeDays before the scan, not undated ones", () => {
  const { candidates, tooOld } = collectCandidates(
    [ok(article("new", daysAgo(2)), article("month", daysAgo(30)), article("old", daysAgo(400)), article("undated", null))],
    [shared],
    { at, maxAgeDays: 365 },
  );
  assert.deepEqual([...candidates.values()].map((a) => a.title), ["new", "month", "undated"]);
  assert.equal(tooOld, 1);
  assert.equal(candidates.get(articleId("https://news.example/month")).ageDays, 30);
  assert.equal(candidates.get(articleId("https://news.example/undated")).ageDays, null);
});

test("maxAgeDays 0 reads articles of any age", () => {
  const { candidates, tooOld } = collectCandidates([ok(article("old", daysAgo(4000)))], [shared], { at, maxAgeDays: 0 });
  assert.equal(candidates.size, 1);
  assert.equal(tooOld, 0);
});

test("old articles are read from the sources of a company that switched the rule off, and only those", () => {
  const offForA = { companyId: "A", disabled: [], skipOld: false };
  const fetched = [ok(article("old-shared", daysAgo(400))), ok(article("old-own", daysAgo(500)))];
  const forA = collectCandidates(fetched, [shared, aFeed], { at, maxAgeDays: 365, oldReaders: [offForA] });
  assert.deepEqual([...forA.candidates.values()].map((a) => a.title), ["old-shared", "old-own"]);

  // A switched the shared source off for itself, so it no longer reads old articles from it.
  const sharedOffForA = { ...offForA, disabled: ["shared"] };
  const off = collectCandidates(fetched, [shared, aFeed], { at, maxAgeDays: 365, oldReaders: [sharedOffForA] });
  assert.deepEqual([...off.candidates.values()].map((a) => a.title), ["old-own"]);
  assert.equal(off.tooOld, 1);

  // B switching the rule off doesn't read A's own source.
  const offForB = { companyId: "B", disabled: [], skipOld: false };
  const forB = collectCandidates(fetched, [shared, aFeed], { at, maxAgeDays: 365, oldReaders: [offForB] });
  assert.deepEqual([...forB.candidates.values()].map((a) => a.title), ["old-shared"]);
});

test("an article carried by several sources keeps each of them and their owners", () => {
  const same = article("same", daysAgo(1));
  const { candidates } = collectCandidates([ok(same), ok(same), { status: "rejected", reason: new Error("HTTP 500") }], [shared, aFeed, shared], {
    at,
    maxAgeDays: 365,
  });
  const [only] = candidates.values();
  assert.deepEqual(only.sourceIds, ["shared", "a-feed"]);
  assert.deepEqual(only.sourceCompanyIds, [null, "A"]);
});

test("Gemini errors read as their message", () => {
  const raw = JSON.stringify({ error: { code: 400, message: "Unable to submit request because thinking_level is not supported by this model.", status: "INVALID_ARGUMENT" } });
  assert.equal(errorText(new Error(raw)), "Unable to submit request because thinking_level is not supported by this model.");
  assert.equal(errorText(new Error("socket hang up")), "socket hang up");
});
