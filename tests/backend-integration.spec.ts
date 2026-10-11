import { test, expect, type Page } from "@playwright/test";

const account = {
  user: {
    id: "user-1",
    name: "Test Owner",
    email: "owner@example.com",
    alerts: true,
    digest: false,
  },
  company: {
    id: "company-1",
    name: "API Company",
    businessRole: "Manufacturer",
    origin: "Vietnam",
    destination: "European Union",
    currency: "USD",
  },
  role: "owner",
  onboarded: true,
};
const order = {
  id: "SERVER-1",
  product: "API plywood",
  supplier: "Server Supplier",
  destination: "Rotterdam",
  valueMinor: 123456,
  currency: "EUR",
  shipDate: "2027-01-21",
  hsCode: "0401.10",
  status: "needs_data",
};
const uploaded = { ...order, id: "IMPORTED-1", status: "awaiting_analysis" };
async function fixture(
  page: Page,
  options: {
    failOrders?: boolean;
    viewer?: boolean;
    onboarding?: boolean;
  } = {},
) {
  const requests: {
    path: string;
    method: string;
    body: any;
    auth: string | undefined;
  }[] = [];
  let rules = [
    { id: "rule-1", text: "Server policy", category: "Policy", enabled: true },
  ];
  let committed = false;
  let me = structuredClone(account);
  if (options.viewer) me.role = "viewer";
  if (options.onboarding) {
    me.onboarded = false;
    (me as any).company = null;
  }
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/v1", "");
    const method = request.method();
    let body: any;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData();
    }
    requests.push({
      path,
      method,
      body,
      auth: request.headers().authorization,
    });
    let data: unknown = {};
    let meta = {};
    if (path === "/me") {
      if (method === "PATCH") me.user = { ...me.user, ...body };
      data = me;
    } else if (path === "/company") {
      me.company = { ...me.company, ...body };
      data = me.company;
    } else if (path === "/onboarding") {
      me = {
        ...me,
        onboarded: true,
        company: { ...account.company, name: body.companyName },
      };
      data = me;
    } else if (path === "/orders") {
      if (options.failOrders) {
        await route.fulfill({
          status: 503,
          json: {
            error: { code: "unavailable", message: "Database is unavailable" },
          },
        });
        return;
      }
      data = url.searchParams.has("cursor")
        ? committed
          ? [uploaded]
          : []
        : [order];
      meta = url.searchParams.has("cursor") ? {} : { nextCursor: "page-two" };
    } else if (path === "/overview")
      data = {
        totalOrders: committed ? 2 : 1,
        countsByStatus: {
          needs_data: 1,
          awaiting_analysis: committed ? 1 : 0,
          clear: 0,
          exposed: 0,
        },
        valueAtRiskByCurrency: { EUR: 123456 },
        nearestAffectedShipDate: null,
        sourcesCheckedAt: null,
      };
    else if (path === "/orders/SERVER-1")
      data = {
        order,
        source: {
          importId: "import-1",
          rowNumber: 2,
          raw: { hsCode: "0401.10", value: "1234.56" },
          rowHash: "hash",
        },
        exposures: [],
      };
    else if (path === "/playbook/rules") {
      if (method === "POST") {
        const rule = { ...body, id: "rule-2" };
        rules.push(rule);
        data = rule;
      } else data = rules;
    } else if (path.startsWith("/playbook/rules/")) {
      const id = path.split("/").pop();
      if (method === "DELETE") {
        rules = rules.filter((rule) => rule.id !== id);
        data = { deleted: true };
      } else {
        rules = rules.map((rule) =>
          rule.id === id ? { ...rule, ...body } : rule,
        );
        data = rules.find((rule) => rule.id === id);
      }
    } else if (path === "/imports" || path === "/imports/import-1")
      data = {
        id: "import-1",
        filename: "orders.csv",
        status: "validated",
        rowCount: 1,
        errors: [],
        preview: [{ ...uploaded, rowNumber: 2 }],
        duplicateOfImportId: null,
      };
    else if (path === "/imports/import-1/commit") {
      committed = true;
      data = { ordersCreated: 1 };
    } else if (path === "/me/logout") data = { signedOut: true };
    else {
      await route.fulfill({
        status: 404,
        json: { error: { message: `Unexpected API ${path}` } },
      });
      return;
    }
    await route.fulfill({ json: { data, meta } });
  });
  await page.route("**/api/impacts**", (route) =>
    route.fulfill({ json: { impacts: [] } }),
  );
  return requests;
}
async function login(page: Page) {
  await page.goto("/#/login");
  await page.getByLabel("Email", { exact: true }).fill("owner@example.com");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("loads paginated API data, preserves statuses/currency, and reads source evidence", async ({
  page,
}) => {
  const requests = await fixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await expect(page.getByText("€1,235").first()).toBeVisible();
  await page.goto("/#/workspace/orders");
  await expect(
    page.getByRole("table").getByText("Needs data", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("API plywood", { exact: true })).toBeVisible();
  await expect(page.getByText("PO-2291", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "SERVER-1", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Original CSV row" }),
  ).toBeVisible();
  await expect(page.getByText("Import import-1 · row 2")).toBeVisible();
  await expect(page.getByText("A documentation gap.")).toHaveCount(0);
  expect(requests.filter((r) => r.path === "/orders")).toHaveLength(2);
  expect(
    requests.every((r) => r.auth === "Bearer dev:owner@example.com"),
  ).toBeTruthy();
});

test("persists playbook mutations, commits imports once, and saves account settings", async ({
  page,
}) => {
  const requests = await fixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/playbook");
  await page
    .getByLabel("In your own words")
    .fill("Review shipment certificates");
  await page.getByRole("button", { name: "Add to my playbook" }).click();
  await expect(
    page.getByText("Review shipment certificates", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("switch", { name: "Enable rule: Review shipment certificates" })
    .click();
  await expect(
    page.getByRole("switch", {
      name: "Enable rule: Review shipment certificates",
    }),
  ).toHaveAttribute("aria-checked", "false");
  await page
    .getByRole("button", { name: "Delete rule: Review shipment certificates" })
    .click();
  await expect(
    page.getByText("Review shipment certificates", { exact: true }),
  ).toHaveCount(0);
  await page.goto("/#/workspace/data");
  await page.locator('input[type="file"]').setInputFiles({
    name: "orders.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "id,product,supplier,destination,value,shipDate,hsCode\nIMPORTED-1,Plywood,Test,EU,100,2027-01-21,0401.10",
    ),
  });
  await expect(
    page.getByRole("button", { name: "Import 1 orders" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Import 1 orders" }).dblclick();
  await expect(
    page.getByRole("button", { name: "IMPORTED-1", exact: true }),
  ).toBeVisible();
  expect(requests.filter((r) => r.path.endsWith("/commit"))).toHaveLength(1);
  expect(
    requests.find((r) => r.path === "/imports/import-1" && r.method === "GET"),
  ).toBeTruthy();
  await page.goto("/#/workspace/account");
  await page.getByLabel("Name", { exact: true }).fill("Updated Owner");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".profile strong")).toHaveText("Updated Owner");
  expect(
    requests.find((r) => r.path === "/me" && r.method === "PATCH")?.body.name,
  ).toBe("Updated Owner");
  expect(
    requests.find((r) => r.path === "/company" && r.method === "PATCH"),
  ).toBeTruthy();
});

test("API errors never fall back to sample orders; viewer mutations are disabled", async ({
  page,
}) => {
  await fixture(page, { failOrders: true });
  await login(page);
  await expect(page.getByText("Database is unavailable")).toBeVisible();
  await expect(page.getByText("PO-2291", { exact: true })).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
  await fixture(page, { viewer: true });
  await page.getByRole("button", { name: "Try again" }).click();
  await page.goto("/#/workspace/playbook");
  await expect(page.getByRole("switch")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Delete rule: Server policy" }),
  ).toBeDisabled();
  await page.goto("/#/workspace/data");
  await expect(page.locator('input[type="file"]')).toBeDisabled();
});

test("new accounts onboard through the API and the sample demo stays local", async ({
  page,
}) => {
  const requests = await fixture(page, { onboarding: true });
  await login(page);
  await expect(page).toHaveURL(/onboarding/);
  await page.getByLabel("Company name").fill("New Company");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page).toHaveURL(/workspace\/data/);
  await expect(page.getByText("New Company", { exact: true })).toBeVisible();
  expect(requests.find((r) => r.path === "/onboarding")?.body.companyName).toBe(
    "New Company",
  );
  await page.goto("/#/logout");
  await expect(page.getByText("Your workspace is saved.")).toBeVisible();
  expect(requests.some((r) => r.path === "/me/logout")).toBeTruthy();
  const count = requests.length;
  await page.goto("/#/login");
  await page.getByRole("button", { name: /demo/i }).click();
  await expect(page.getByText("DEMO WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/orders");
  await expect(
    page.getByRole("button", { name: "PO-2291", exact: true }),
  ).toBeVisible();
  expect(requests.length).toBe(count);
});
