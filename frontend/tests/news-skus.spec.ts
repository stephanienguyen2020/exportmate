import { test, expect } from "@playwright/test";

const affected = (sku: string, name: string) => ({ sku, name, reason: "r", stockValueUsd: 1 });
const impact = {
  id: "imp-1",
  title: "EU deforestation rules",
  url: "https://news.example/eudr",
  publisher: "Example",
  sourceName: "Timber news",
  publishedAt: new Date().toISOString(),
  severity: "high",
  direction: "risk",
  headline: "EU clarifies deforestation rules for furniture and plywood",
  why: "Why it matters.",
  action: "",
  affected: [
    affected("PLY-101", "Acacia plywood 18 mm"),
    affected("RWP-101", "Rubberwood panel"),
    affected("FUR-103", "Oak sideboard"),
  ],
  stockValueUsd: 3,
  createdAt: new Date().toISOString(),
};
const item = (sku: string, name: string, hsCode: string, markets: string[]) => ({
  sku,
  name,
  hsCode,
  markets,
  category: "",
  species: "",
  timberOrigin: "",
  supplier: "",
  certifications: [],
  geolocationOnFile: false,
  warehouse: "",
  unit: "pcs",
  qtyOnHand: 1,
  unitCostUsd: 1,
});
const stock = [
  // Three demo orders ship plywood (4412) to the EU.
  item("PLY-101", "Acacia plywood 18 mm", "4412.33", ["EU"]),
  // One demo order ships HS 4418 to Korea.
  item("RWP-101", "Rubberwood panel", "4418.99", ["KR"]),
  // No demo order is furniture (9403).
  item("FUR-103", "Oak sideboard", "9403.60", ["EU"]),
];

test("a news alert's stock items link to the orders they match", async ({ page }) => {
  await page.route("**/api/impacts**", (route) => route.fulfill({ json: { impacts: [impact], scan: null } }));
  await page.route("**/api/inventory**", (route) => route.fulfill({ json: { items: stock } }));
  await page.goto("/");
  await page.evaluate(() => sessionStorage.setItem("em-session", "demo"));
  await page.goto("/#/workspace/news");
  const card = page.locator(".news-list .news-card");

  // Several matches: the chip lists them.
  await card.getByRole("button", { name: "PLY-101: 3 matching orders" }).click();
  const pop = page.getByRole("dialog", { name: "Orders for PLY-101" });
  await expect(pop.getByRole("link", { name: /PO-2291/ })).toBeVisible();
  await expect(pop.getByRole("link", { name: /PO-2304/ })).toBeVisible();
  await expect(pop.getByRole("link", { name: /PO-2315/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();

  // No match: the chip says why.
  await card.getByRole("button", { name: /FUR-103/ }).click();
  await expect(page.getByRole("dialog", { name: "Orders for FUR-103" })).toContainText(
    "No open order has HS heading 9403 and ships to EU.",
  );

  // One match: the chip goes straight to the order.
  await card.getByRole("link", { name: /RWP-101/ }).click();
  await expect(page).toHaveURL(/#\/workspace\/orders\/PO-2314$/);
  await expect(page.getByText("PO-2314").first()).toBeVisible();
});

test("the +N chip on a news card shows the rest of its stock items", async ({ page }) => {
  const many = {
    ...impact,
    affected: [...impact.affected, affected("OUT-101", "Teak bench"), affected("OUT-102", "Teak table"), affected("FLR-102", "Oak floor")],
  };
  await page.route("**/api/impacts**", (route) => route.fulfill({ json: { impacts: [many], scan: null } }));
  await page.route("**/api/inventory**", (route) => route.fulfill({ json: { items: stock } }));
  await page.goto("/");
  await page.evaluate(() => sessionStorage.setItem("em-session", "demo"));
  await page.goto("/#/workspace/news");
  const card = page.locator(".news-list .news-card");

  await expect(card.getByText("FLR-102", { exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: "Show 2 more stock items" }).click();
  await expect(card.locator(".news-skus").getByText("FLR-102")).toBeVisible();
  await card.getByRole("button", { name: "Show fewer stock items" }).click();
  await expect(card.locator(".news-skus").getByText("FLR-102")).toHaveCount(0);
});
