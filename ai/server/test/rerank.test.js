import { test } from "node:test";
import assert from "node:assert/strict";
import { bm25, rerank, terms } from "../rerank.js";

test("terms keep codes whole and split", () => {
  assert.deepEqual(terms("HS 4412.33 for PLY-103"), ["hs", "4412.33", "4412", "33", "ply-103", "ply", "103"]);
  assert.deepEqual(terms("What tariffs hit the US?"), ["tariff", "hit", "us"]);
});

test("bm25 favours rare exact terms and stays in [0, 1]", () => {
  const docs = [terms("EUDR geolocation rules for plywood"), terms("plywood prices in Vietnam"), terms("furniture tariffs")];
  const scores = bm25(terms("EUDR plywood"), docs);
  assert.ok(scores[0] > scores[1] && scores[1] > scores[2]);
  assert.ok(scores.every((s) => s >= 0 && s <= 1));
  assert.deepEqual(bm25(terms("x"), []), []);
});

test("rerank lifts an exact code match over a slightly closer vector hit", () => {
  const hits = [
    { id: "a", score: 0.71, title: "Plywood duties", text: "Duties on plywood imports" },
    { id: "b", score: 0.69, title: "PLY-103 · Eucalyptus plywood", text: "Stock item PLY-103, HS code 4412.33" },
    { id: "c", score: 0.5, title: "Furniture", text: "Sofa frames" },
  ];
  const out = rerank("PLY-103 stock", hits, 2);
  assert.deepEqual(out.map((h) => h.id), ["b", "a"]);
  assert.ok(out[0].lexical > out[1].lexical);
  assert.equal(out[0].score, 0.69);
});
