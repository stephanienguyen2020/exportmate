import { test } from "node:test";
import assert from "node:assert/strict";
import { catalog } from "../scan.js";
import { decide } from "../relevance.js";
import { REGISTRY, makeRefs } from "../agents/tools.js";
import { generateInventory } from "../seed/inventory.js";
import { companyGoods } from "../goods.js";

const goods = companyGoods({ name: "Saigon Knit Co.", businessRole: "Manufacturer", origin: "Vietnam", destination: "EU", products: "" }, [
  { order: { id: "PO-1", product: "Cotton T-shirt", hsCode: "6109.10", supplier: "Mill A", shipDate: "2026-11-01" }, placement: { market: "EU" } },
  { order: { id: "PO-2", product: "Wool scarf", hsCode: "6117.10", supplier: "Mill B", shipDate: "2026-11-02" }, placement: { market: "UK" } },
]).items;

test("the scan's stock lines show what each item has", () => {
  const [tee] = goods.filter((i) => i.name === "Cotton T-shirt");
  assert.equal(catalog([tee]), `${tee.sku} | Cotton T-shirt | HS 6109.10 | supplier Mill A | sells to EU`);
  const [sample] = generateInventory();
  assert.equal(
    catalog([sample]),
    `${sample.sku} | ${sample.name} | ${sample.category} | HS ${sample.hsCode} | ${sample.material} from ${sample.materialOrigin} | supplier ${sample.supplier} | sells to ${sample.markets.join("/")} | certs ${sample.certifications.join("+") || "none"} | origin trace ${sample.originTraced ? "on file" : "MISSING"} | ${sample.qtyOnHand} ${sample.unit}`,
  );
});

test("an alert on a company's goods names them without a stock value", () => {
  const bySku = new Map(goods.map((i) => [i.sku, i]));
  const [tee] = goods;
  const verdict = decide({ title: "EU tightens textile labelling", snippet: "" }, { relevant: true, affected: [{ sku: tee.sku, reason: "EU-bound" }] }, 0, bySku, { company: "Saigon Knit Co." });
  assert.deepEqual(verdict.affected, [{ sku: tee.sku, name: tee.name, reason: "EU-bound" }]);
  assert.equal(verdict.relevant, true);
});

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
