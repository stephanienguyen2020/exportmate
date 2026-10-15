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

test("an imported order is checked against the sample rule change", async ({
  page,
}) => {
  await openDemo(page, "#/workspace/data");
  const csv = [
    "id,product,supplier,destination,value,shipDate,hsCode,currency",
    'PO-9001,Acacia plywood 18mm,Binh Phu Wood,"Rotterdam, NL",30000,2026-11-20,4412.33,USD',
    'PO-9003,Rubberwood chairs,Unknown Mill,"Los Angeles, US",8000,2026-11-25,9401.61,USD',
  ].join("\n");
  await page.locator('input[type="file"]').setInputFiles({
    name: "orders.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await page.getByRole("button", { name: "Import 2 orders" }).click();
  await expect(
    page.getByText(
      "2 orders imported. 1 order needs action under the sample rule change.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Action needed", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "PO-9001", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "PO-9003", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "PO-9001", exact: true }).click();
  await expect(
    page.getByText("Binh Phu Wood has no geolocation record for this lot."),
  ).toBeVisible();
  // Three orders now need action: the walkthrough and the overview both count them.
  await page.goto("/#/workspace");
  await expect(page.locator(".metric-value.danger")).toContainText("03");
  await expect(page.getByText(/Binh Phu Wood must provide/)).toContainText(
    "3 EU-bound orders",
  );
});

test("the overview's figures come from the orders and today's date", async ({
  page,
}) => {
  await openDemo(page);
  const today = await page.evaluate(() =>
    new Date()
      .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
      .toUpperCase(),
  );
  await expect(page.locator(".greeting")).toContainText(today);
  // The seed's first affected order ships 12 days from today.
  const next = page.locator(".metrics > div").nth(3);
  await expect(next.locator(".metric-value")).toContainText("12");
  await expect(next.locator(".metric-note")).toContainText(
    "Rotterdam, Netherlands · PO-2291",
  );
  const risk = page.locator(".metrics > div").nth(2);
  await expect(risk.locator(".metric-value")).toHaveText("$2,400USD");
  // Hovering the estimate says how it was worked out and where each number comes from.
  await risk.locator(".cost-why").hover();
  const why = page.getByRole("tooltip");
  await expect(why).toContainText("2 orders × ($400 + 4 days × $200)");
  await expect(why).toContainText("default cost of a missing supplier document (USD 400)");
  await page.mouse.move(0, 0);
  await expect(why).toHaveCount(0);
  await page.getByRole("button", { name: "Buyer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Buyer", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The amount already names its currency, so it isn't repeated.
  await expect(risk.locator(".metric-value")).toHaveText("SGD 14,800");
});

test("the demo never shows a signed-in account's profile", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem(
      "em-profile",
      JSON.stringify({ name: "Real Person", email: "real@company.com", company: "Real Co" }),
    ),
  );
  await openDemo(page, "#/workspace/account");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Ms. Lan");
  await expect(page.getByText("Real Co")).toHaveCount(0);
});

test("the assistant gets the demo's orders and playbook, and shows code", async ({
  page,
}) => {
  let sent: any = null;
  await page.route("**/api/chat", async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/x-ndjson",
      body:
        JSON.stringify({
          type: "done",
          reply: "Add an `hsCode` column.",
          citations: [],
          audit: null,
        }) + "\n",
    });
  });
  await openDemo(page, "#/workspace/orders");
  await page.getByRole("button", { name: "Open assistant" }).click();
  await page.getByLabel("Message").fill("Why does PO-2291 need action?");
  await page.keyboard.press("Enter");
  await expect(page.locator(".chat-msg.model code")).toHaveText("hsCode");
  const po2291 = sent.demo.orders.find((o: any) => o.id === "PO-2291");
  expect(po2291).toMatchObject({ status: "exposed", market: "EU", check: { status: "missing" } });
  expect(sent.demo.orders[0].status).toBe("exposed");
  expect(sent.demo.rules.map((r: any) => r.category)).toEqual([
    "Threshold",
    "Policy",
    "Supplier",
    "Watchlist",
  ]);
});

test("news alerts filter by severity, text, source, stock item and date", async ({
  page,
}) => {
  const daysAgo = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString();
  const alert = (o: Record<string, unknown>) => ({
    url: "https://news.example/a",
    publisher: "Example",
    sourceName: "Timber news",
    severity: "medium",
    direction: "risk",
    why: "Why it matters.",
    action: "",
    affected: [],
    stockValueUsd: 1000,
    createdAt: daysAgo(0),
    ...o,
  });
  const impacts = [
    alert({
      id: "a",
      title: "Oak tariff",
      headline: "US raises oak duty",
      severity: "high",
      publishedAt: daysAgo(2),
      affected: [{ sku: "OAK-1", name: "Oak table", reason: "r", stockValueUsd: 1 }],
    }),
    alert({
      id: "b",
      title: "Teak rules",
      headline: "Teak certificate change",
      sourceName: "Customs feed",
      publishedAt: daysAgo(3),
      affected: [{ sku: "TEAK-2", name: "Teak chair", reason: "r", stockValueUsd: 1 }],
    }),
    alert({
      id: "c",
      title: "Old story",
      headline: "Freight rates fall",
      direction: "opportunity",
      severity: "low",
      publishedAt: daysAgo(40),
      affected: [{ sku: "OAK-1", name: "Oak table", reason: "r", stockValueUsd: 1 }],
    }),
  ];
  await openDemo(page, "#/workspace/news");
  // Registered last, so it answers before openDemo's empty list.
  await page.route("**/api/impacts**", (route) =>
    route.fulfill({ json: { impacts, scan: null } }),
  );
  await page.reload();
  const cards = page.locator(".news-list .news-card");
  await expect(cards).toHaveCount(3);

  await page.getByRole("button", { name: "High", exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(page.getByText("Showing 1 of 3 alerts.")).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();

  await page.getByLabel("Search alerts").fill("teak");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Teak certificate change");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(cards).toHaveCount(3);

  await page.getByLabel("Source").selectOption("Customs feed");
  await expect(cards).toHaveCount(1);
  await page.getByLabel("Source").selectOption("");

  await page.getByLabel("Stock item").selectOption("OAK-1");
  await expect(cards).toHaveCount(2);
  await page.getByLabel("Published").selectOption("7");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("US raises oak duty");

  await page.getByLabel("Stock item").selectOption("TEAK-2");
  await page.getByLabel("Search alerts").fill("freight");
  await expect(cards).toHaveCount(0);
  await expect(page.getByText("No alerts here.")).toBeVisible();
});

test("people confirm or reject which demo orders a news alert affects", async ({
  page,
}) => {
  const impacts = [
    {
      id: "eudr",
      title: "EUDR guidance",
      url: "https://news.example/eudr",
      publisher: "EU press",
      sourceName: "Timber news",
      publishedAt: new Date().toISOString(),
      severity: "high",
      direction: "risk",
      headline: "EU tightens plywood geolocation checks",
      why: "Why it matters.",
      action: "",
      affected: [
        { sku: "PLY-001", name: "Acacia plywood 18 mm", reason: "r", stockValueUsd: 1 },
      ],
      stockValueUsd: 1,
      createdAt: new Date().toISOString(),
    },
  ];
  const items = [
    { sku: "PLY-001", name: "Acacia plywood 18 mm", hsCode: "4412.33", markets: ["EU"] },
  ];
  await openDemo(page, "#/workspace/news");
  await page.route("**/api/impacts**", (route) =>
    route.fulfill({ json: { impacts, scan: null } }),
  );
  await page.route("**/api/inventory**", (route) =>
    route.fulfill({ json: { items } }),
  );
  await page.reload();

  // The three EU-bound HS 4412 sample orders are suggested; nothing is decided yet.
  const panel = page.locator(".news-orders");
  await expect(panel.getByText("3 to review")).toBeVisible();
  await expect(panel.locator("li")).toHaveCount(0);
  await panel.getByRole("button", { name: /Orders this may affect/ }).click();
  await expect(panel.locator("li")).toHaveCount(3);
  await expect(panel.getByText("HS 4412 and ships to EU").first()).toBeVisible();

  await page.getByRole("button", { name: "Add a note on PO-2291" }).click();
  await page.getByLabel("PO-2291 (optional)").fill("Our Rotterdam lot.");
  await page.getByRole("button", { name: "PO-2291: affects this order" }).click();
  await page.getByRole("button", { name: "PO-2304: not relevant" }).click();
  await expect(panel.locator("li.confirmed")).toContainText("“Our Rotterdam lot.”");
  await expect(panel.locator("li.rejected")).toContainText("PO-2304");
  await expect(panel.getByText("1 to review")).toBeVisible();

  // A person can link an order that wasn't suggested.
  await page.getByLabel("Order to link").selectOption("PO-2310");
  await page.getByRole("button", { name: "Link order" }).click();
  await expect(panel.locator("li.confirmed")).toHaveCount(2);
  await expect(panel.getByText("did not suggest this order")).toBeVisible();

  // Verdicts stay in this browser; undo puts a suggestion back to review.
  await page.reload();
  await panel.getByRole("button", { name: /Orders this may affect/ }).click();
  await expect(panel.locator("li.confirmed")).toHaveCount(2);
  await page.getByRole("button", { name: "Undo the verdict on PO-2304" }).click();
  await expect(panel.getByText("2 to review")).toBeVisible();

  await page.getByLabel("Orders", { exact: true }).selectOption("none");
  await expect(page.locator(".news-list .news-card")).toHaveCount(0);
  await page.getByLabel("Orders", { exact: true }).selectOption("review");
  await expect(page.locator(".news-list .news-card")).toHaveCount(1);
});
