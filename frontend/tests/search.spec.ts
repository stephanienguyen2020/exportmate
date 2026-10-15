import { test, expect, type Page } from "@playwright/test";

const impact = {
  id: "imp-1",
  title: "EU tightens deforestation checks on plywood",
  url: "https://example.com/eudr-plywood",
  publisher: "Example News",
  sourceName: "Example feed",
  publishedAt: "2026-10-01T08:00:00Z",
  severity: "high",
  direction: "risk",
  headline: "Deforestation checks tighten for plywood",
  why: "Importers must hold geolocation for every batch.",
  action: "Ask suppliers for plot coordinates.",
  affected: [{ sku: "PLY-18", name: "Acacia plywood 18 mm", reason: "EU-bound", stockValueUsd: 1200 }],
  stockValueUsd: 1200,
  createdAt: "2026-10-01T09:00:00Z",
};
const item = {
  sku: "PLY-18",
  name: "Acacia plywood 18 mm",
  category: "Panels",
  hsCode: "4412",
  material: "Acacia",
  supplier: "Binh Phu Wood",
  markets: ["EU"],
};

async function openDemo(page: Page, hash = "#/workspace") {
  await page.route("**/api/impacts**", (route) =>
    route.fulfill({ json: { impacts: [impact], scan: null } }),
  );
  await page.route("**/api/inventory**", (route) => route.fulfill({ json: { items: [item] } }));
  await page.goto("/");
  await page.evaluate(() => sessionStorage.setItem("em-session", "demo"));
  await page.goto("/" + hash);
}

test("one search finds orders, news, stock, rules and pages", async ({ page }) => {
  await openDemo(page);
  await expect(page.getByRole("button", { name: "Search the workspace" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search the workspace" });
  const box = dialog.getByRole("combobox");
  await expect(box).toBeFocused();
  // With no query, the pages are offered.
  await expect(dialog.getByRole("option", { name: /Trade map/ })).toBeVisible();

  await box.fill("plywood");
  await expect(dialog.getByRole("option", { name: /PO-2291/ })).toBeVisible();
  await expect(dialog.getByRole("option", { name: /Deforestation checks tighten/ })).toBeVisible();
  await expect(dialog.getByRole("option", { name: /PLY-18/ })).toBeVisible();

  await box.fill("binh phu 3 weeks");
  await expect(dialog.getByRole("option", { name: /Allow Binh Phu Wood/ })).toBeVisible();

  await box.fill("nothing like this");
  await expect(dialog.getByText("No matches for “nothing like this”.")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("arrow keys and Enter open the chosen result", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("button", { name: "Search the workspace" }).click();
  const box = page.getByRole("combobox");
  await box.fill("PO-2291");
  await expect(page.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/workspace\/orders\/PO-2291$/);
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.keyboard.press("/");
  await box.fill("playbook");
  await page.getByRole("option", { name: /^Playbook/ }).click();
  await expect(page).toHaveURL(/#\/workspace\/playbook$/);
});

test("the search fits a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page);
  await page.getByRole("button", { name: "Search the workspace" }).click();
  await page.getByRole("combobox").fill("plywood");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("option", { name: /PO-2291/ })).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(16);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390 - 16);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
