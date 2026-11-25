import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Order } from "../../src/data";
import { hsHeading, suggestOrders, type StockItem } from "./news-matches";

const order = (id: string, hsCode: string, destination: string): Order => ({
  id,
  product: "Item",
  supplier: "Maker",
  destination,
  value: 1000,
  shipDate: "2099-01-01",
  hsCode,
  risk: false,
});
const item = (sku: string, hsCode: string, markets: string[]): StockItem => ({
  sku,
  name: `Item ${sku}`,
  hsCode,
  markets,
});

describe("hsHeading", () => {
  it("keeps the first four digits", () => {
    expect(hsHeading("4407.11")).toBe("4407");
    expect(hsHeading("44 07 11")).toBe("4407");
    expect(hsHeading("440")).toBe("");
    expect(hsHeading(undefined)).toBe("");
  });

  it("is four digits or empty, and stable", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const heading = hsHeading(s);
        expect(heading).toMatch(/^(\d{4})?$/);
        expect(hsHeading(heading)).toBe(heading);
      }),
    );
  });
});

describe("suggestOrders", () => {
  const stock = new Map([
    ["S1", item("S1", "4407.11", ["EU"])],
    ["S2", item("S2", "9403.60", ["Raw material"])],
  ]);
  const orders = [
    order("EU-1", "4407.12", "Rotterdam, NL"),
    order("US-1", "4407.12", "Seattle, US"),
    order("ANY-1", "9403.20", "Seattle, US"),
    order("OTHER", "6109.10", "Rotterdam, NL"),
  ];

  it("matches the HS heading and, when the item names markets, the market", () => {
    const found = suggestOrders(
      { id: "a", headline: "", affected: [{ sku: "S1", name: "" }, { sku: "S2", name: "" }] },
      stock,
      orders,
    );
    expect(found.map((f) => f.order.id)).toEqual(["EU-1", "ANY-1"]);
    expect(found[0].reason).toBe("HS 4407 and ships to EU, like Item S1 named in this alert.");
    expect(found[1].reason).toBe("HS 9403, like Item S2 named in this alert.");
  });

  it("skips items it doesn't stock", () => {
    expect(suggestOrders({ id: "a", headline: "", affected: [{ sku: "X", name: "" }] }, stock, orders)).toEqual([]);
  });

  it("suggests each order once and only orders sharing a heading with a named item", () => {
    const hs = fc.constantFrom("4407.11", "4407.99", "9403.60", "61", "");
    const market = fc.constantFrom("EU", "US", "UK", "Raw material");
    const dest = fc.constantFrom("Rotterdam, NL", "Seattle, US", "Leeds, GB", "Nowhere");
    fc.assert(
      fc.property(
        fc.array(fc.tuple(hs, fc.array(market, { maxLength: 2 })), { maxLength: 4 }),
        fc.array(fc.tuple(hs, dest), { maxLength: 8 }),
        (items, rows) => {
          const stockMap = new Map(items.map(([h, m], i) => [`S${i}`, item(`S${i}`, h, m)]));
          const open = rows.map(([h, d], i) => order(`O${i}`, h, d));
          const found = suggestOrders(
            { id: "a", headline: "", affected: items.map((_, i) => ({ sku: `S${i}`, name: "" })) },
            stockMap,
            open,
          );
          const ids = found.map((f) => f.order.id);
          expect(new Set(ids).size).toBe(ids.length);
          const headings = new Set(items.map(([h]) => hsHeading(h)).filter(Boolean));
          for (const f of found) expect(headings).toContain(hsHeading(f.order.hsCode));
        },
      ),
    );
  });
});
