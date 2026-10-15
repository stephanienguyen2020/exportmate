import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_GOODS, aboutCompany, companyGoods, goodsFingerprint, goodsId, profileProducts } from "../goods.js";

const company = {
  name: "Saigon Knit Co.",
  businessRole: "Manufacturer",
  origin: "Vietnam",
  transit: ["Singapore"],
  destination: "European Union",
  description: "Knitwear for European retailers.",
  products: "Cotton T-shirts, merino sweaters;\nCotton T-shirts",
  materials: "Organic cotton (India)",
  certifications: "GOTS",
};
const mapOrder = (id, product, hsCode, market, supplier, shipDate) => ({
  order: { id, product, hsCode, supplier, shipDate },
  placement: { market },
});

test("profile products are split, trimmed and listed once", () => {
  assert.deepEqual(profileProducts(company.products), ["Cotton T-shirts", "merino sweaters"]);
  assert.deepEqual(profileProducts(""), []);
});

test("an item's id stays the same for the same product and HS code", () => {
  assert.equal(goodsId("Cotton T-shirt", "6109.10"), goodsId("  cotton   t-shirt ", "610910"));
  assert.notEqual(goodsId("Cotton T-shirt", "6109.10"), goodsId("Cotton T-shirt", "6109.90"));
  assert.match(goodsId("Cotton T-shirt"), /^G-[0-9A-F]{6}$/);
});

test("orders with the same product and HS code make one item with every market and supplier", () => {
  const { profile, items } = companyGoods(company, [
    mapOrder("PO-1", "Cotton T-shirt", "6109.10", "EU", "Mill A", "2026-11-01"),
    mapOrder("PO-2", "Cotton T-shirt", "6109.10", "US", "Mill B", "2026-12-01"),
    mapOrder("PO-3", "Wool scarf", "6117.10", "UK", "Mill A", "2026-10-20"),
    mapOrder("PO-4", "  ", "6117.10", "UK", "Mill A", "2026-10-20"),
  ]);
  assert.deepEqual(profile, {
    company: "Saigon Knit Co.",
    about:
      "a manufacturer based in Vietnam shipping Vietnam → Singapore → European Union; Knitwear for European retailers; main materials: Organic cotton (India); certifications: GOTS",
  });
  assert.deepEqual(
    items.map((i) => [i.name, i.hsCode, i.markets, i.supplier, i.orders, i.source]),
    [
      ["Cotton T-shirts", "", [], "", [], "profile"],
      ["merino sweaters", "", [], "", [], "profile"],
      ["Cotton T-shirt", "6109.10", ["US", "EU"], "Mill B, Mill A", ["PO-2", "PO-1"], "orders"],
      ["Wool scarf", "6117.10", ["UK"], "Mill A", ["PO-3"], "orders"],
    ],
  );
});

test("an order with no HS code joins the profile product it names", () => {
  const { items } = companyGoods(company, [mapOrder("PO-9", "merino sweaters", "", "EU", "Mill C", "2026-11-01")]);
  const sweaters = items.find((i) => i.name === "merino sweaters");
  assert.deepEqual([sweaters.orders, sweaters.markets, sweaters.source], [["PO-9"], ["EU"], "profile"]);
  assert.equal(items.length, 2);
});

test("goods are capped, and the same goods give the same fingerprint", () => {
  const many = Array.from({ length: MAX_GOODS + 5 }, (_, n) => mapOrder(`PO-${n}`, `Product ${n}`, "8471.30", "EU", "S", "2026-11-01"));
  const goods = companyGoods({ ...company, products: "" }, many);
  assert.equal(goods.items.length, MAX_GOODS);
  assert.equal(goodsFingerprint(goods), goodsFingerprint(companyGoods({ ...company, products: "" }, many)));
});

test("a sparse profile still describes the company", () => {
  assert.equal(aboutCompany({ businessRole: "", origin: "", destination: "" }), "a company");
  assert.deepEqual(companyGoods(null, []), { profile: { company: "", about: "" }, items: [] });
});
