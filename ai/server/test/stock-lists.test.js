import { test } from "node:test";
import assert from "node:assert/strict";
import { REGISTRY, withStockLists } from "../agents/tools.js";
import { validateArgs } from "../gateway.js";

const items = [
  { sku: "TEX-101", category: "Knitwear", markets: ["EU", "US"] },
  { sku: "TEX-102", category: "Denim", markets: ["US"] },
  { sku: "TEX-103", category: "Knitwear", markets: [] },
];

test("query_inventory's category and market filters list what the stock holds", () => {
  const { properties } = withStockLists(REGISTRY, items).query_inventory.declaration.parameters;
  assert.deepEqual(properties.category.enum, ["Denim", "Knitwear"]);
  assert.deepEqual(properties.market.enum, ["EU", "US"]);
  const { parameters } = withStockLists(REGISTRY, items).query_inventory.declaration;
  assert.deepEqual(validateArgs(parameters, { category: "Knitwear" }), []);
  assert.equal(validateArgs(parameters, { category: "Plywood" }).length, 1);
  // The shared registry is left as it was.
  assert.equal(REGISTRY.query_inventory.declaration.parameters.properties.category.enum, undefined);
});

test("with no stock read, the filters take any text", () => {
  const { properties } = withStockLists(REGISTRY, []).query_inventory.declaration.parameters;
  assert.equal(properties.category.enum, undefined);
  assert.equal(properties.market.enum, undefined);
});
