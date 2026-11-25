import fc from "fast-check";
import { describe, expect, it } from "vitest";
import cases from "../../testdata/order-values.json";
import {
  MAX_IMPORT_ROWS,
  MAX_LENGTHS,
  REQUIRED_COLUMNS,
  isCurrency,
  orderCellErrors,
  parseValue,
  validValueText,
  validateOrderCsv,
} from "./order-csv";

const row = (overrides: Record<string, string> = {}) => ({
  id: "PO-1",
  product: "Cotton T-shirt",
  supplier: "Saigon Knit Co.",
  destination: "Rotterdam, NL",
  value: "24000",
  shipDate: "2026-10-27",
  hsCode: "6109.10",
  ...overrides,
});
const fields = [...REQUIRED_COLUMNS, "currency"];

describe("value cells", () => {
  // The same answers as backend/app/services/order_csv.py (tests/test_order_csv.py reads it too).
  it.each(cases.valid)("accepts %j", (text) => expect(validValueText(text)).toBe(true));
  it.each(cases.invalid)("rejects %j", (text) => expect(validValueText(text)).toBe(false));

  it("reads thousands commas", () => {
    expect(parseValue("24,000.50")).toBe(24000.5);
  });

  it("accepts every amount in cents below 1 trillion", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 14n - 1n }), (cents) => {
        const text = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
        expect(validValueText(text)).toBe(true);
        expect(Math.round(parseValue(text) * 100)).toBe(Number(cents));
      }),
    );
  });

  it("rejects a third decimal that isn't zero-padded away", () => {
    fc.assert(
      fc.property(fc.nat({ max: 10 ** 9 }), fc.integer({ min: 1, max: 9 }), (whole, digit) => {
        expect(validValueText(`${whole}.00${digit}`)).toBe(false);
      }),
    );
  });

  it("never accepts text with a character outside the number grammar", () => {
    const junk = fc.string().filter((s) => /[^\d.,+eE-]/.test(s));
    fc.assert(
      fc.property(junk, (text) => {
        expect(validValueText(text)).toBe(false);
      }),
    );
  });
});

describe("orderCellErrors", () => {
  const errors = (cells: Record<string, string>) =>
    orderCellErrors((c) => cells[c] ?? "").map((e) => e.column);

  it("passes a complete order", () => expect(errors(row())).toEqual([]));

  it("allows an empty HS code but not a malformed one", () => {
    expect(errors(row({ hsCode: "" }))).toEqual([]);
    expect(errors(row({ hsCode: "61-09" }))).toEqual(["hsCode"]);
  });

  it("rejects impossible dates", () => {
    expect(errors(row({ shipDate: "2026-02-30" }))).toEqual(["shipDate"]);
    expect(errors(row({ shipDate: "27/10/2026" }))).toEqual(["shipDate"]);
  });

  it("checks the currency, falling back to the company's", () => {
    expect(errors(row({ currency: "eur" }))).toEqual([]);
    expect(errors(row({ currency: "XYZ" }))).toEqual(["currency"]);
    expect(orderCellErrors((c) => row()[c as keyof ReturnType<typeof row>] ?? "", "ABC")).toEqual([
      { column: "currency", message: "currency must be a 3-letter code like USD." },
    ]);
  });

  it("flags every required column that is blank", () => {
    fc.assert(
      fc.property(fc.subarray(REQUIRED_COLUMNS.filter((c) => c !== "hsCode")), (blank) => {
        const cells = row(Object.fromEntries(blank.map((c) => [c, ""])));
        expect(errors(cells).sort()).toEqual([...blank].sort());
      }),
    );
  });

  it("enforces each length limit exactly at the boundary", () => {
    for (const [column, limit] of Object.entries(MAX_LENGTHS)) {
      expect(errors(row({ [column]: "x".repeat(limit) }))).toEqual([]);
      expect(errors(row({ [column]: "x".repeat(limit + 1) }))).toEqual([column]);
    }
  });
});

describe("validateOrderCsv", () => {
  it("reports missing columns before anything else", () => {
    const result = validateOrderCsv(["id", "product"], [row()], new Set());
    expect(result.orders).toEqual([]);
    expect(result.errors[0]).toMatch(/^Missing columns: supplier, destination/);
  });

  it("refuses an empty file and one with too many rows", () => {
    expect(validateOrderCsv(fields, [], new Set()).errors).toEqual(["The file has no order rows."]);
    const many = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => row({ id: `PO-${i}` }));
    expect(validateOrderCsv(fields, many, new Set()).errors).toEqual([
      `Too many rows. Limit is ${MAX_IMPORT_ROWS}.`,
    ]);
  });

  it("numbers errors by file line (the header is line 1)", () => {
    const result = validateOrderCsv(fields, [row(), row({ id: "PO-2", value: "-1" })], new Set());
    expect(result.errors).toEqual([
      "Row 3: value must be a positive number with at most 2 decimals.",
    ]);
    expect(result.orders.map((o) => o.id)).toEqual(["PO-1"]);
  });

  it("rejects ids repeated in the file or already saved", () => {
    const result = validateOrderCsv(fields, [row(), row(), row({ id: "OLD" })], new Set(["OLD"]));
    expect(result.orders.map((o) => o.id)).toEqual(["PO-1"]);
    expect(result.errors).toEqual([
      "Row 3: order PO-1 already exists.",
      "Row 4: order OLD already exists.",
    ]);
  });

  // Rows built from arbitrary ids, with some broken values sprinkled in.
  const rows = fc.array(
    fc.record({
      id: fc.constantFrom("A", "B", "C", "D", " E "),
      value: fc.constantFrom("100", "1,250.50", "abc", "-3", "0.001"),
    }),
    { maxLength: 30 },
  );

  it("accepts each row at most once, with unique ids, and explains every rejected row", () => {
    fc.assert(
      fc.property(rows, fc.subarray(["A", "B"]), (cells, saved) => {
        const input = cells.map((c) => row(c));
        const result = validateOrderCsv(fields, input, new Set(saved));
        const ids = result.orders.map((o) => o.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of saved) expect(ids).not.toContain(id);
        const rejected = input.length - result.orders.length;
        const rowsWithErrors = new Set(result.errors.map((e) => e.match(/^Row (\d+):/)?.[1]));
        if (input.length) expect(rowsWithErrors.size).toBe(rejected);
        for (const order of result.orders) {
          expect(order.id).toBe(order.id.trim());
          expect(order.value).toBeGreaterThan(0);
          expect(order.currency).toBe("USD");
        }
      }),
    );
  });
});

describe("isCurrency", () => {
  it("knows ISO codes and refuses other shapes", () => {
    expect(isCurrency("VND")).toBe(true);
    expect(isCurrency("usd")).toBe(false);
    expect(isCurrency("US")).toBe(false);
  });
});
