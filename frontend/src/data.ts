export type Order = {
  id: string;
  product: string;
  supplier: string;
  destination: string;
  value: number;
  shipDate: string;
  hsCode: string;
  risk: boolean;
  currency?: string;
  status?: "awaiting_analysis" | "clear" | "exposed" | "needs_data";
};
export type Rule = {
  id: string;
  text: string;
  category: string;
  enabled: boolean;
};
// Today's date as YYYY-MM-DD in the visitor's time zone.
export const isoDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysFromToday = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoDay(d);
};
/** Whole days from today to a YYYY-MM-DD date (negative once it has passed). */
export const daysUntil = (day: string) =>
  Math.round(
    (Date.parse(day + "T12:00:00") - Date.parse(isoDay() + "T12:00:00")) /
      86_400_000,
  );

// The sample demo's one rule change, applied to every order in the browser (seeded or
// imported). Illustrative, like the rest of the demo; signed-in companies get their
// checklists from the backend instead (GET /api/v1/trade-map).
export const sampleObligation = {
  title: "Geolocation documentation for EU-bound wood",
  short: "Geolocation data missing.",
  before:
    "Supplier-level origin documentation is present in the firm's existing records.",
  requirement: "plot-level geolocation",
  // An order is covered when its HS code starts with one of these or its product names a material.
  hsPrefixes: ["4412.33"],
  materials: ["acacia"],
  market: "EU",
  marketName: "European Union",
  clause: "Sample clause §9",
};
// Suppliers' records in the demo. A supplier missing here has no record at all.
export const sampleSuppliers: Record<string, { geolocation: boolean }> = {
  "binh phu wood": { geolocation: false },
  "an cuong wood": { geolocation: true },
  "mekong timber": { geolocation: true },
};
// The demo's cost assumptions per affected order: illustrative, not a tariff or quote.
export const sampleCosts = {
  maker: { documentation: 400, delayDays: 4, delayPerDay: 200, currency: "USD" },
  buyer: { margin: 7400, currency: "SGD" },
};
export const makerCost =
  sampleCosts.maker.documentation +
  sampleCosts.maker.delayDays * sampleCosts.maker.delayPerDay;
// The source collections the sample rule watch reads (shown on Rule watch).
export const sampleSources = [
  { code: "EU", name: "European Union", scope: "Wood & deforestation", source: "EUR-Lex" },
  { code: "VN", name: "Vietnam", scope: "Origin & export documentation", source: "Government law portal" },
  { code: "SG", name: "Singapore", scope: "Customs & re-export", source: "Singapore Customs" },
];

const EU_COUNTRIES = new Set(
  "AT BE BG HR CY CZ DK EE FI FR DE GR IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "),
);
let regionNames: Intl.DisplayNames | null = null;
/** "NL" → "Netherlands"; the code itself if the browser can't name it. */
export function countryName(code: string) {
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}
/** The ISO country code of a destination such as "Rotterdam, NL" or "Hamburg, Germany", if known. */
export function destinationCountry(destination: string) {
  const last = destination.split(",").pop()!.trim();
  if (/^[A-Za-z]{2}$/.test(last)) return last.toUpperCase();
  const name = last.toLowerCase();
  for (const code of EU_COUNTRIES) if (countryName(code).toLowerCase() === name) return code;
  return null;
}
/** "Rotterdam, NL" → "Rotterdam, Netherlands". */
export function placeName(destination: string) {
  const code = destinationCountry(destination);
  const city = destination.split(",").slice(0, -1).join(",").trim();
  return code && city ? `${city}, ${countryName(code)}` : destination;
}
const hsDigits = (hs: string) => hs.replace(/\D/g, "");

type OrderFacts = Pick<Order, "product" | "supplier" | "destination" | "hsCode">;
/** The sample rule's check on an order: null when the rule doesn't cover it. */
export function sampleCheck(o: OrderFacts): { status: "missing" | "on_file"; note: string } | null {
  const country = destinationCountry(o.destination);
  if (!country || !EU_COUNTRIES.has(country)) return null;
  const covered =
    sampleObligation.hsPrefixes.some((p) => hsDigits(o.hsCode).startsWith(hsDigits(p))) ||
    sampleObligation.materials.some((m) => o.product.toLowerCase().includes(m));
  if (!covered) return null;
  const record = sampleSuppliers[o.supplier.trim().toLowerCase()];
  if (record?.geolocation)
    return { status: "on_file", note: `${o.supplier}'s geolocation record is on file.` };
  return {
    status: "missing",
    note: record
      ? `${o.supplier} has no geolocation record for this lot.`
      : `${o.supplier} has no supplier record, so no geolocation document is on file.`,
  };
}
/** Why an order breaks the sample rule change, or null when it doesn't. */
export function sampleGap(o: OrderFacts) {
  const check = sampleCheck(o);
  return check?.status === "missing" ? check.note : null;
}
/** The order with its risk worked out from the sample rule change. */
export const withSampleRisk = (o: Order): Order => ({ ...o, risk: Boolean(sampleGap(o)) });

const seedOrders: Omit<Order, "risk">[] = [
  {
    id: "PO-2291",
    product: "Acacia plywood · 18 mm",
    supplier: "Binh Phu Wood",
    destination: "Rotterdam, NL",
    value: 24000,
    shipDate: daysFromToday(12),
    hsCode: "4412.33",
  },
  {
    id: "PO-2304",
    product: "Acacia plywood · 12 mm",
    supplier: "Binh Phu Wood",
    destination: "Hamburg, DE",
    value: 18000,
    shipDate: daysFromToday(15),
    hsCode: "4412.33",
  },
  ...[
    "Singapore, SG",
    "Osaka, JP",
    "Antwerp, BE",
    "Singapore, SG",
    "Busan, KR",
    "Rotterdam, NL",
    "Tokyo, JP",
    "Singapore, SG",
    "Hamburg, DE",
    "Osaka, JP",
  ].map((destination, i) => ({
    id: `PO-${2310 + i}`,
    product: i % 2 ? "Birch plywood · 12 mm" : "Rubberwood panels · 20 mm",
    supplier: i % 2 ? "Mekong Timber" : "An Cuong Wood",
    destination,
    value: 12000 + i * 1500,
    shipDate: daysFromToday(18 + i),
    hsCode: i % 2 ? "4412.32" : "4418.99",
  })),
];
// Ship dates count from today, so the sample never drifts into the past.
export const initialOrders: Order[] = seedOrders.map((o) =>
  withSampleRisk({ ...o, risk: false }),
);
export const initialRules: Rule[] = [
  {
    id: "1",
    text: "Flag any order where the projected margin drops below 8%.",
    category: "Threshold",
    enabled: true,
  },
  {
    id: "2",
    text: "Never ship an order without its required certificate of origin.",
    category: "Policy",
    enabled: true,
  },
  {
    id: "3",
    text: "Allow Binh Phu Wood 3 weeks to provide any new documentation.",
    category: "Supplier",
    enabled: true,
  },
  {
    id: "4",
    text: "Watch for changes affecting HS 4412 and EU-bound wood products.",
    category: "Watchlist",
    enabled: true,
  },
];
export const money = (n: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(n);
export const date = (s: string) =>
  new Date(s + "T12:00:00").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
export function readSaved<T>(
  key: string,
  fallback: T,
  validate: (v: unknown) => boolean,
): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return validate(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Browser storage may be unavailable. */
  }
}
