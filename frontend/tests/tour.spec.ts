import { test, expect, type Page } from "@playwright/test";

// The first-visit workspace tour, in the browser-only demo.
test.use({ storageState: { cookies: [], origins: [] } });

async function openDemo(page: Page) {
  await page.route("**/api/impacts**", (route) =>
    route.fulfill({ json: { impacts: [], scan: null } }),
  );
  await page.goto("/");
  await page.evaluate(() => sessionStorage.setItem("em-session", "demo"));
  await page.goto("/#/workspace");
}

test("the tour opens on a first visit, walks the sidebar and can be replayed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 800 });
  await openDemo(page);
  const tour = page.getByRole("dialog", { name: "Welcome to ExportMate." });
  await expect(tour).toBeVisible();
  await page.getByRole("button", { name: "Show me around" }).click();
  await expect(page.getByRole("dialog", { name: "Overview" })).toBeVisible();
  await expect(page.locator(".tour-spotlight")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("dialog", { name: "Orders" })).toBeVisible();
  // The card sits beside the sidebar item it describes, not over it.
  const item = await page.locator('[data-tour="nav-orders"]').boundingBox();
  const card = await page.locator(".tour-card").boundingBox();
  expect(card!.x).toBeGreaterThan(item!.x + item!.width);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("dialog", { name: "Overview" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".tour")).toHaveCount(0);

  // Seen once: a reload doesn't bring it back, the ? button does.
  await page.reload();
  await expect(page.locator(".nav-item").first()).toBeVisible();
  await expect(page.locator(".tour")).toHaveCount(0);
  await page.getByRole("button", { name: "Show the workspace tour" }).click();
  await expect(tour).toBeVisible();
  await page.getByRole("button", { name: "Skip tour" }).click();
  await expect(page.locator(".tour")).toHaveCount(0);
});

test("on a phone the tour steps are centred cards that fit the screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page);
  await page.getByRole("button", { name: "Show me around" }).click();
  await expect(page.getByRole("dialog", { name: "Overview" })).toBeVisible();
  await expect(page.locator(".tour-spotlight")).toHaveCount(0);
  const card = await page.locator(".tour-card").boundingBox();
  expect(card!.x).toBeGreaterThanOrEqual(0);
  expect(card!.x + card!.width).toBeLessThanOrEqual(390);
  // The last step points at the ? button, which is in the phone's top bar too.
  for (let i = 0; i < 20; i++) {
    const next = page.getByRole("button", { name: "Next" });
    if (!(await next.isVisible())) break;
    await next.click();
  }
  await expect(page.getByRole("dialog", { name: "That's it." })).toBeVisible();
  await expect(page.locator(".tour-spotlight")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".tour")).toHaveCount(0);
});
