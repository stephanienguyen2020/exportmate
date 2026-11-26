import { test } from "node:test";
import assert from "node:assert/strict";
import { REGISTRY, makeRefs } from "../agents/tools.js";
import { generateInventory } from "../seed/inventory.js";
// A company's goods as the backend builds them (GET /api/v1/news-goods), newest ship date first.
const goods = [
  { sku: "G-15881E", name: "Wool scarf", hsCode: "6117.10", markets: ["UK"], orders: ["PO-2"], source: "orders", supplier: "Mill B" },
  { sku: "G-3D9799", name: "Cotton T-shirt", hsCode: "6109.10", markets: ["EU"], orders: ["PO-1"], source: "orders", supplier: "Mill A" },
];

test("query_inventory reads the turn's own stock: a company's goods have no values", async () => {
  const refs = makeRefs();
  const { output } = await REGISTRY.query_inventory.run({ market: "UK" }, { refs, stock: goods });
  assert.equal(output.matching, 1);
  assert.equal(output.totalStockValueUsd, undefined);
  assert.deepEqual(
    output.items.map((i) => [i.name, i.hsCode, i.orders, i.stockValueUsd]),
    [["Wool scarf", "6117.10", ["PO-2"], undefined]],
  );
  const byHs = await REGISTRY.query_inventory.run({ hsCode: "6109" }, { refs, stock: goods });
  assert.deepEqual(byHs.output.items.map((i) => i.name), ["Cotton T-shirt"]);
});

test("query_inventory still totals the sample stock", async () => {
  const stock = generateInventory();
  const { output } = await REGISTRY.query_inventory.run({ skus: [stock[0].sku, stock[1].sku] }, { refs: makeRefs(), stock });
  const value = (i) => Math.round(i.qtyOnHand * i.unitCostUsd);
  assert.equal(output.totalStockValueUsd, value(stock[0]) + value(stock[1]));
});
