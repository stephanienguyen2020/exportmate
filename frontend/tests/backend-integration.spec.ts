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
    description: "Plywood and furniture for export.",
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
const reportContent = (title: string) => ({
  title,
  subtitle: "Order compliance report · API Company",
  summary: "SERVER-1 ships to European Union on 21 Jan 2027.",
  sections: [
    {
      id: "order",
      layout: "facts",
      heading: "Order",
      note: "",
      empty: "",
      columns: ["Field", "Value"],
      widths: [32, 68],
      toneColumn: null,
      included: true,
      rows: [
        { id: "order-product", cells: ["Product", "API plywood"], tone: null, included: true },
      ],
    },
    {
      id: "checklist",
      layout: "table",
      heading: "Document checklist",
      note: "Checked against the supplier documents on file.",
      empty: "No checklist lines apply.",
      columns: ["Requirement", "Status", "Note", "Source"],
      widths: [38, 20, 52, 10],
      toneColumn: 1,
      included: true,
      rows: [
        {
          id: "check-geolocation",
          cells: ["Plot-level geolocation", "Missing", "Not on file.", "[1]"],
          tone: "gap",
          included: true,
        },
        {
          id: "check-legality",
          cells: ["Timber legality evidence", "On file", "VNTLAS dossier", "[1]"],
          tone: null,
          included: true,
        },
      ],
    },
  ],
});
const noEdits = { header: false, sections: 0, rowsEdited: 0, rowsAdded: 0, rowsRemoved: 0 };
const tradeMap = {
  markets: [
    {
      code: "EU",
      name: "European Union",
      shortName: "EU",
      hub: { latitude: 51.9, longitude: 4.5 },
      countryIds: [],
      searchTerms: [],
    },
  ],
  orders: [
    {
      order,
      placement: { city: "Rotterdam", country: "NL", market: "EU", location: null, approximate: true },
      checks: [
        {
          requirementKey: "eudr-geolocation",
          title: "Plot-level geolocation",
          level: "supplier",
          status: "missing",
          note: "Not on file.",
          source: {
            regulationId: "reg-1",
            regulationTitle: "EU Deforestation Regulation",
            officialId: "2023/1115",
            documentId: "doc-1",
            documentTitle: "Regulation (EU) 2023/1115",
            versionNumber: 2,
            sourceUrl: null,
            quote: "Geolocation of all plots of land where the commodities were produced.",
          },
        },
      ],
      gapCount: 1,
    },
  ],
  suppliers: [],
  sites: [],
  observations: [],
  documentKinds: [],
  countries: [],
  homeCountryIds: [],
  checkRadiusKm: 25,
};
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
    idempotencyKey?: string;
  }[] = [];
  let rules = [
    { id: "rule-1", text: "Server policy", category: "Policy", enabled: true },
  ];
  let committed = false;
  const reports = new Map<string, any>();
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
      idempotencyKey: request.headers()["idempotency-key"],
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
    else if (path === "/reports" && method === "POST") {
      const id = `r-${reports.size + 1}`;
      const title =
        body.kind === "company"
          ? "What's happening and what it affects"
          : `${body.orderId} · API plywood`;
      const draft = {
        id,
        kind: body.kind,
        title,
        scope: body.kind === "company" ? { days: body.days } : { orderId: body.orderId },
        createdAt: "2026-10-15T08:00:00Z",
        updatedAt: "2026-10-15T08:00:00Z",
        sentAt: null,
        sentTo: null,
        companyName: "API Company",
        preparedBy: "Test Owner",
        content: reportContent(title),
        original: reportContent(title),
        edits: noEdits,
      };
      reports.set(id, draft);
      await route.fulfill({ status: 201, json: { data: draft, meta } });
      return;
    } else if (path === "/reports") data = [...reports.values()];
    else if (/^\/reports\/r-\d+\/pdf$/.test(path)) {
      await route.fulfill({
        contentType: "application/pdf",
        headers: {
          "Content-Disposition": 'inline; filename="exportmate-SERVER-1-API-plywood.pdf"',
        },
        body: "%PDF-1.4 test report",
      });
      return;
    } else if (/^\/reports\/r-\d+\/email$/.test(path)) {
      const draft = reports.get(path.split("/")[2]);
      draft.sentAt = "2026-10-15T09:00:00Z";
      draft.sentTo = body.to;
      data = { recipients: body.to, sandbox: true, sentAt: draft.sentAt };
    } else if (/^\/reports\/r-\d+$/.test(path)) {
      const draft = reports.get(path.split("/")[2]);
      if (method === "PATCH") {
        draft.content = body.content;
        draft.title = body.content.title;
      }
      data = draft;
    }
    else if (path === "/trade-map") data = tradeMap;
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

test("rule watch shows the company's own requirements, not the sample scenario", async ({
  page,
}) => {
  await fixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/rules");
  await expect(page.getByRole("heading", { name: "Plot-level geolocation" })).toBeVisible();
  await expect(page.getByText("1 of 1 orders have a gap")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /EU Deforestation Regulation/ }),
  ).toHaveAttribute("href", "#/workspace/regulations/documents/doc-1");
  await expect(page.getByText("Geolocation documentation for EU-bound wood")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run rule-change demo" })).toHaveCount(0);
});

test("prepares an order report, edits it, previews the PDF and emails it once", async ({
  page,
}) => {
  const requests = await fixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/orders/SERVER-1");
  await page.getByRole("button", { name: "Prepare report" }).click();
  await expect(page).toHaveURL(/#\/workspace\/reports\/r-1$/);
  await expect(
    page.getByRole("heading", { name: "SERVER-1 · API plywood" }),
  ).toBeVisible();
  expect(requests.find((r) => r.path === "/reports")?.body).toEqual({
    kind: "order",
    orderId: "SERVER-1",
  });

  await page.getByLabel("Title", { exact: true }).fill("SERVER-1 for our buyer");
  const checklist = page.getByRole("region", { name: "Document checklist" });
  const geolocation = checklist.getByRole("listitem").first();
  await geolocation.getByLabel("Note").fill("Requested from supplier on 14 Oct.");
  await expect(geolocation.getByText("Edited", { exact: true })).toBeVisible();
  await checklist
    .getByRole("listitem")
    .nth(1)
    .getByRole("button", { name: "Leave out" })
    .click();
  await checklist.getByRole("button", { name: "Add line" }).click();
  await checklist.getByRole("listitem").nth(2).getByLabel("Requirement").fill("Buyer audit");
  await expect(page.getByText(/Your edits: title or summary rewritten · 1 line changed · 1 added · 1 left out/)).toBeVisible();

  await page.getByRole("button", { name: "Preview PDF" }).click();
  await expect(page.locator('iframe[title="Report PDF preview"]')).toBeVisible();
  const saved = requests.find((r) => r.method === "PATCH" && r.path === "/reports/r-1");
  expect(saved?.body.content.title).toBe("SERVER-1 for our buyer");
  const rows = saved?.body.content.sections[1].rows;
  expect(rows[0].cells[2]).toBe("Requested from supplier on 14 Oct.");
  expect(rows[1].included).toBe(false);
  expect(rows[2]).toMatchObject({ cells: ["Buyer audit", "", "", ""], included: true });
  expect(requests.some((r) => r.path === "/reports/r-1/pdf")).toBeTruthy();

  await page.getByRole("button", { name: "Email report" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("To").fill("buyer@example.com, not-an-address");
  await dialog.getByRole("button", { name: "Send report" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "“not-an-address” is not an email address.",
  );
  await dialog.getByLabel("To").fill("buyer@example.com; qa@example.org");
  await dialog.getByLabel("Message (optional)").fill("Checklist attached.");
  await dialog.getByRole("button", { name: "Send report" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText(
      "Sandbox: the report email to buyer@example.com, qa@example.org was recorded but not delivered.",
    ),
  ).toBeVisible();
  const [sent] = requests.filter((r) => r.path === "/reports/r-1/email");
  expect(sent.body).toEqual({
    to: ["buyer@example.com", "qa@example.org"],
    message: "Checklist attached.",
  });
  expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  // Sent reports are locked.
  await expect(page.getByText(/Sent to buyer@example.com, qa@example.org/)).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Email report" })).toHaveCount(0);
});

test("generates a company report for the chosen window", async ({ page }) => {
  const requests = await fixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.getByRole("button", { name: "Company report" }).click();
  await expect(page.getByRole("heading", { name: "Reports." })).toBeVisible();
  await expect(page.getByText("No reports yet.")).toBeVisible();
  await page.getByLabel("Window").selectOption("90");
  await page.getByRole("button", { name: "Generate company report" }).click();
  await expect(page).toHaveURL(/#\/workspace\/reports\/r-1$/);
  await expect(
    page.getByRole("heading", { name: "What's happening and what it affects" }),
  ).toBeVisible();
  expect(requests.find((r) => r.path === "/reports" && r.method === "POST")?.body).toEqual({
    kind: "company",
    days: 90,
  });
  await page.getByRole("link", { name: "All reports" }).click();
  await expect(page.getByText("Company · 90 days")).toBeVisible();
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
  // The first click only asks for confirmation.
  await expect(
    page.getByText("Review shipment certificates", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Confirm delete rule: Review shipment certificates",
    })
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
  // Only the name changed, so the company is left alone.
  expect(
    requests.find((r) => r.path === "/company" && r.method === "PATCH"),
  ).toBeFalsy();
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
  await page.goto("/#/workspace/orders/SERVER-1");
  await page.getByRole("button", { name: "Prepare report" }).click();
  await expect(page.getByRole("button", { name: "Preview PDF" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Email report" })).toBeDisabled();
  await expect(page.getByText("Only owners and editors can email reports.")).toBeVisible();
});

test("new accounts onboard through the API and the sample demo stays local", async ({
  page,
}) => {
  const requests = await fixture(page, { onboarding: true });
  await login(page);
  await expect(page).toHaveURL(/onboarding/);
  await page.getByLabel("Company name").fill("New Company");
  await page
    .getByLabel("What does your company do?")
    .fill("Plywood and furniture for export.");
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
  // Signing out forgot the account's cached profile; the demo shows its own company.
  expect(await page.evaluate(() => localStorage.getItem("em-profile"))).toBeNull();
  await expect(page.getByText("Binh Duong Wood Co.").first()).toBeVisible();
  await expect(page.getByText("New Company", { exact: true })).toHaveCount(0);
  await page.goto("/#/workspace/orders");
  await expect(
    page.getByRole("button", { name: "PO-2291", exact: true }),
  ).toBeVisible();
  expect(requests.length).toBe(count);
});

// News sources live on the AI service and are shared by every workspace, so
// only signed-in owners and editors may change them (with their own token).
async function sourcesFixture(page: Page) {
  const changes: { method: string; auth: string | undefined }[] = [];
  let sources = [
    {
      id: "source-1",
      name: "Timber news",
      url: "https://news.example/feed.xml",
      kind: "News",
      builtIn: true,
      enabled: true,
    },
  ];
  await page.route("**/api/sources**", async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === "GET") {
      await route.fulfill({ json: { sources } });
      return;
    }
    changes.push({ method, auth: request.headers().authorization });
    if (method === "POST") {
      const source = {
        ...request.postDataJSON(),
        id: "source-2",
        kind: "Custom",
        builtIn: false,
        enabled: true,
      };
      sources = [...sources, source];
      await route.fulfill({ status: 201, json: { source, sample: [] } });
      return;
    }
    const id = new URL(request.url()).pathname.split("/").pop();
    sources = sources.map((s) =>
      s.id === id ? { ...s, ...request.postDataJSON() } : s,
    );
    await route.fulfill({ json: { ok: true } });
  });
  return changes;
}
async function openSources(page: Page) {
  await page.goto("/#/workspace/news");
  await page.getByRole("button", { name: "Sources", exact: true }).click();
}

test("owners add and switch off news sources with their token", async ({
  page,
}) => {
  await fixture(page);
  const changes = await sourcesFixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await openSources(page);
  await page
    .getByPlaceholder("Name, e.g. Vietnam Customs news")
    .fill("Customs feed");
  await page
    .getByPlaceholder("https://example.com/feed.xml")
    .fill("https://customs.example/rss");
  await page.getByRole("button", { name: "Add source" }).click();
  await expect(page.getByText("Customs feed", { exact: true })).toBeVisible();
  const timber = page.getByRole("checkbox", { name: "Read Timber news" });
  // The visible switch covers the checkbox; click it as a user would.
  await page.locator("label").filter({ has: timber }).click();
  await expect(timber).not.toBeChecked();
  expect(changes.map((c) => c.method)).toEqual(["POST", "PATCH"]);
  expect(
    changes.every((c) => c.auth === "Bearer dev:owner@example.com"),
  ).toBeTruthy();
});

test("viewers and the sample demo can't change news sources", async ({
  page,
}) => {
  await fixture(page, { viewer: true });
  const changes = await sourcesFixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await openSources(page);
  await expect(
    page.getByText("Only company owners and editors can change sources."),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Read Timber news" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add source" })).toHaveCount(0);
  await page.goto("/#/logout");
  await expect(page.getByText("Your workspace is saved.")).toBeVisible();
  await page.goto("/#/login");
  await page.getByRole("button", { name: /demo/i }).click();
  await expect(page.getByText("DEMO WORKSPACE")).toBeVisible();
  await openSources(page);
  await expect(
    page.getByText(
      "Sign in to a company workspace to add or switch off sources.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Read Timber news" }),
  ).toBeDisabled();
  expect(changes).toHaveLength(0);
});

test("a failed change shows an error toast, not a success one", async ({
  page,
}) => {
  await fixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  // Registered last, so it answers before the fixture's handler.
  await page.route("**/api/v1/playbook/rules", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 422,
          json: { error: { code: "invalid", message: "Rule text is too long." } },
        })
      : route.fallback(),
  );
  await page.goto("/#/workspace/playbook");
  await page.getByLabel("In your own words").fill("A rule the server rejects");
  await page.getByRole("button", { name: "Add to my playbook" }).click();
  const toast = page.getByRole("alert").filter({ hasText: "Rule text is too long." });
  await expect(toast).toBeVisible();
  await expect(toast).toHaveClass(/error/);
});
