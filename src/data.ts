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
export const initialOrders: Order[] = [
  {
    id: "PO-2291",
    product: "Acacia plywood · 18 mm",
    supplier: "Binh Phu Wood",
    destination: "Rotterdam, NL",
    value: 24000,
    shipDate: "2026-10-27",
    hsCode: "4412.33",
    risk: true,
  },
  {
    id: "PO-2304",
    product: "Acacia plywood · 12 mm",
    supplier: "Binh Phu Wood",
    destination: "Hamburg, DE",
    value: 18000,
    shipDate: "2026-10-30",
    hsCode: "4412.33",
    risk: true,
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
    shipDate: `2026-11-${String(i + 2).padStart(2, "0")}`,
    hsCode: i % 2 ? "4412.32" : "4418.99",
    risk: false,
  })),
];
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
