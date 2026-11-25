// The browser demo repeats a few backend rules. These run the cases in shared/parity/ through
// the demo's copies; backend/tests/test_parity.py runs the same files through the backend.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { destinationCountry } from "../src/data";
import { checkOrderCsv } from "../src/order-csv";

const cases = <T>(name: string): T[] =>
  JSON.parse(readFileSync(new URL(`../../shared/parity/${name}`, import.meta.url), "utf8"))
    .cases;

for (const c of cases<{ case: string; csv: string; errors: string[] }>("order-csv.json"))
  test(`order CSV: ${c.case}`, async () => {
    const { errors } = await checkOrderCsv(c.csv, new Set());
    expect(errors).toEqual(c.errors);
  });

test("destinations name the backend's countries", () => {
  for (const c of cases<{ destination: string; country: string | null }>("destinations.json"))
    expect(destinationCountry(c.destination), JSON.stringify(c.destination)).toBe(c.country);
});
