import { test } from "node:test";
import assert from "node:assert/strict";
import { aboutWoodGoods } from "../relevance.js";

test("drops other commodities that never mention wood", () => {
  assert.equal(aboutWoodGoods({ title: "Ghana's cocoa faces EU deforestation test in three months", snippet: "Cocoa farmers must map their farms." }), false);
  assert.equal(aboutWoodGoods({ title: "Coffee exporters prepare for EUDR", snippet: "" }), false);
});

test("keeps wood goods, including ones that also mention other commodities", () => {
  assert.ok(aboutWoodGoods({ title: "EUDR: what it means for timber and cocoa", snippet: "" }));
  assert.ok(aboutWoodGoods({ title: "Rubberwood furniture exports rise", snippet: "" }));
  assert.ok(aboutWoodGoods({ title: "US court keeps Chinese plywood exporters out of antidumping order", snippet: "" }));
});

test("leaves general trade measures to the model", () => {
  assert.ok(aboutWoodGoods({ title: "US raises tariffs on imports from Vietnam", snippet: "A 46% duty applies from August." }));
});
