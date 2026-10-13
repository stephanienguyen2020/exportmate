import { test, expect, type Page } from "@playwright/test";

// The browser-only sample demo: no backend, so these run against the Vite server alone.
async function openDemo(page: Page, hash = "#/workspace") {
  await page.route("**/api/impacts**", (route) =>
    route.fulfill({ json: { impacts: [], scan: null } }),
  );
  await page.goto("/");
  await page.evaluate(() => sessionStorage.setItem("em-session", "demo"));
  await page.goto("/" + hash);
}

test("the sidebar scrolls on short screens so Sign out stays reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 680 });
  await openDemo(page);
  const signOut = page.locator(".workspace-signout");
  await signOut.scrollIntoViewIfNeeded();
  await expect(signOut).toBeInViewport();
});

test("the mobile menu marks the current page and offers Sign out", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page, "#/workspace/orders");
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const menu = page.getByRole("navigation", { name: "Workspace" });
  await expect(menu.getByRole("link", { name: "Orders" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await menu.getByRole("link", { name: "Sign out" }).click();
  await expect(page.getByText("You’re signed out.")).toBeVisible();
});

test("orders on a phone show their status without sideways scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page, "#/workspace/orders");
  const status = page
    .getByRole("table")
    .getByText("Action needed", { exact: true })
    .first();
  await expect(status).toBeInViewport();
  const box = await status.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

test("a workspace deep link survives the trip through sign-in to the demo", async ({
  page,
}) => {
  await page.route("**/api/v1/**", (route) => route.abort());
  await page.goto("/#/workspace/map/market/EU");
  await expect(page).toHaveURL(/#\/login$/);
  await page.getByRole("button", { name: /demo/i }).click();
  await expect(page).toHaveURL(/#\/workspace\/map\/market\/EU$/);
});

test("headings keep their spaces when line breaks are hidden", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await openDemo(page, "#/workspace/orders/PO-2291");
  await expect(page.locator(".recommendation h2")).toHaveText(
    /Start with\s+your supplier\./,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/workspace/data");
  await expect(page.locator(".data-help h3")).toHaveText(
    /Less setup\.\s+More clarity\./,
  );
});

test("the supplier message is signed by the person using the workspace", async ({
  page,
}) => {
  await openDemo(page, "#/workspace/account");
  await page.getByLabel("Name", { exact: true }).fill("Minh Tran");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.goto("/#/workspace/orders/PO-2291");
  await page.getByRole("button", { name: /supplier message/ }).click();
  await expect(page.locator("#supplier-message")).toHaveValue(
    /Minh Tran · Binh Duong Wood Co\.$/,
  );
});

test("CSV checks match the backend and say how many problems are hidden", async ({
  page,
}) => {
  await openDemo(page, "#/workspace/data");
  const rows = ["id,product,supplier,destination,value,shipDate,hsCode"];
  for (let i = 0; i < 15; i++) rows.push(`X-${i},P,S,D,10,2026-12-01,44`);
  await page.locator('input[type="file"]').setInputFiles({
    name: "bad.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(rows.join("\n")),
  });
  await expect(
    page.getByText(
      "Row 2: hsCode must look like 4412.33 (digits, optional dots).",
    ),
  ).toBeVisible();
  await expect(page.getByText("…and 5 more.", { exact: false })).toBeVisible();
});

test("deleting a playbook rule needs a second click", async ({ page }) => {
  await openDemo(page, "#/workspace/playbook");
  const text = "Allow Binh Phu Wood 3 weeks to provide any new documentation.";
  await page.getByRole("button", { name: `Delete rule: ${text}` }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: `Confirm delete rule: ${text}` })
    .click();
  await expect(page.getByText(text, { exact: true })).toHaveCount(0);
});

test("signing out forgets the chat; sign-in pages have no chat button", async ({
  page,
}) => {
  await openDemo(page);
  await expect(page.getByRole("button", { name: "Open assistant" })).toBeVisible();
  await page.evaluate(() =>
    sessionStorage.setItem(
      "em-chat",
      JSON.stringify([{ role: "user", text: "What does my company make?" }]),
    ),
  );
  await page.goto("/#/logout");
  await expect(page.getByText("You’re signed out.")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("em-chat"))).toBeNull();
  await page.goto("/#/login");
  await expect(page.getByRole("button", { name: "Open assistant" })).toHaveCount(
    0,
  );
});
