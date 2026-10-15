// Orders CSV checks for the browser-only demo. Same rules as the backend
// (backend/app/services/order_csv.py), so both accept and reject the same files.
import type { Order } from "./data";

export const REQUIRED_COLUMNS = [
  "id",
  "product",
  "supplier",
  "destination",
  "value",
  "shipDate",
  "hsCode",
];
// The hsCode column must be there, but a cell may be empty (the order then needs data).
const OPTIONAL_VALUES = new Set(["hsCode"]);
const MAX_LENGTHS: Record<string, number> = {
  id: 100,
  product: 300,
  supplier: 300,
  destination: 200,
};
export const MAX_IMPORT_ROWS = 10_000;
// Vercel functions accept request bodies up to about 4.5 MB, so every layer uses 4 MB.
export const MAX_UPLOAD_MB = 4;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// 4412 / 4412.33 / 441233 / 4412.33.00, kept as text so "0401.10" keeps its zero.
const HS_CODE = /^\d{4}(\.?\d{2}){0,3}$/;

let currencies: Set<string> | null = null;
export function isCurrency(code: string) {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    currencies ??= new Set(Intl.supportedValuesOf("currency"));
    return currencies.has(code);
  } catch {
    return true; // Older browsers: the 3-letter shape is all we can check.
  }
}

const validDate = (text: string) =>
  DATE.test(text) &&
  !Number.isNaN(Date.parse(text)) &&
  new Date(text).toISOString().slice(0, 10) === text;

const validValue = (n: number) =>
  Number.isFinite(n) &&
  n > 0 &&
  n < 1e12 &&
  Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

/** Checks parsed CSV rows; returns the valid orders and one message per problem. */
export function validateOrderCsv(
  fields: string[] | undefined,
  rows: Record<string, string | undefined>[],
  existingIds: Set<string>,
  defaultCurrency = "USD",
): { orders: Order[]; errors: string[] } {
  const headers = (fields || []).map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length)
    return {
      orders: [],
      errors: [
        `Missing columns: ${missing.join(", ")}. Download the template below.`,
      ],
    };
  if (rows.length > MAX_IMPORT_ROWS)
    return {
      orders: [],
      errors: [`Too many rows. Limit is ${MAX_IMPORT_ROWS}.`],
    };
  const errors: string[] = [];
  const orders: Order[] = [];
  const seen = new Set<string>();
  rows.forEach((raw, i) => {
    const line = i + 2; // the header is line 1
    const cell = (key: string) => (raw[key] ?? "").trim();
    const before = errors.length;
    const fail = (message: string) => errors.push(`Row ${line}: ${message}`);
    for (const column of REQUIRED_COLUMNS)
      if (!OPTIONAL_VALUES.has(column) && !cell(column))
        fail(`${column} is required.`);
    for (const [column, limit] of Object.entries(MAX_LENGTHS))
      if (cell(column).length > limit)
        fail(`${column} is longer than ${limit} characters.`);
    const value = Number(cell("value").replace(/,/g, ""));
    if (cell("value") && !validValue(value))
      fail("value must be a positive number with at most 2 decimals.");
    const shipDate = cell("shipDate");
    if (shipDate && !validDate(shipDate))
      fail("use a valid YYYY-MM-DD ship date.");
    const hsCode = cell("hsCode");
    if (hsCode && !HS_CODE.test(hsCode))
      fail("hsCode must look like 4412.33 (digits, optional dots).");
    const currency = (cell("currency") || defaultCurrency).toUpperCase();
    if (!isCurrency(currency))
      fail("currency must be a 3-letter code like USD.");
    const id = cell("id");
    if (id && (seen.has(id) || existingIds.has(id)))
      fail(`order ${id} already exists.`);
    seen.add(id);
    if (errors.length === before)
      orders.push({
        id,
        product: cell("product"),
        supplier: cell("supplier"),
        destination: cell("destination"),
        value,
        shipDate,
        hsCode,
        currency,
        risk: false,
      });
  });
  if (!rows.length) errors.push("The file has no order rows.");
  return { orders, errors };
}
