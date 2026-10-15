import { test } from "node:test";
import assert from "node:assert/strict";
import { aboutStockedGoods } from "../relevance.js";

// The sample stock is a wood exporter's (seed/inventory.js STOCK_PROFILE).
test("drops goods the stock doesn't hold when the article never names its own", () => {
  assert.equal(aboutStockedGoods({ title: "Ghana's cocoa faces EU deforestation test in three months", snippet: "Cocoa farmers must map their farms." }), false);
  assert.equal(aboutStockedGoods({ title: "Coffee exporters prepare for EUDR", snippet: "" }), false);
});

test("keeps the stock's own goods, including articles that also name other goods", () => {
  assert.ok(aboutStockedGoods({ title: "EUDR: what it means for timber and cocoa", snippet: "" }));
  assert.ok(aboutStockedGoods({ title: "Rubberwood furniture exports rise", snippet: "" }));
  assert.ok(aboutStockedGoods({ title: "US court keeps Chinese plywood exporters out of antidumping order", snippet: "" }));
});

test("leaves general trade measures to the model", () => {
  assert.ok(aboutStockedGoods({ title: "US raises tariffs on imports from Vietnam", snippet: "A 46% duty applies from August." }));
});

test("follows the stock's profile, whatever the industry", () => {
  const coffee = { goodsTerms: ["coffee", "arabica", "robusta"], otherGoods: ["cocoa", "wood", "timber"] };
  assert.ok(aboutStockedGoods({ title: "Coffee exporters prepare for EUDR", snippet: "" }, coffee));
  assert.equal(aboutStockedGoods({ title: "Timber importers face new EU checks", snippet: "" }, coffee), false);
  // A profile that names no other goods leaves every article to the model.
  assert.ok(aboutStockedGoods({ title: "Ghana's cocoa faces EU deforestation test", snippet: "" }, { goodsTerms: ["steel"] }));
});
