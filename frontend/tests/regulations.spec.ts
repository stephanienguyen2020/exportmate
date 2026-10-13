import { test, expect, type Page } from "@playwright/test";
const version = {
  id: "doc-1",
  title: "Timber sourcing policy",
  filename: "policy.txt",
  contentType: "text/plain",
  sizeBytes: 64,
  checksum: "a".repeat(64),
  sourceUrl: "https://example.com/policy",
  regulationId: "company-rule",
  versionNumber: 1,
  createdAt: "2026-10-13T10:00:00Z",
};
const company = {
  id: "company-rule",
  title: version.title,
  officialId: "TIMBER-01",
  shared: false,
  versionCount: 1,
  latestVersion: version,
  createdAt: version.createdAt,
};
const shared = {
  ...company,
  id: "shared-rule",
  title: "Official forest regulation",
  officialId: "OFFICIAL-01",
  shared: true,
  latestVersion: { ...version, id: "shared-doc", regulationId: "shared-rule" },
};
async function fixture(page: Page, role = "owner", signedIn = true) {
  const requests: {
    path: string;
    method: string;
    body: string;
    auth?: string;
  }[] = [];
  let documents = [version];
  let records = [company, shared];
  if (signedIn) await page.addInitScript(() => {
    sessionStorage.setItem("em-session", "api");
    sessionStorage.setItem("em-dev-email", "owner@example.com");
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const method = request.method();
    requests.push({
      path,
      method,
      body: request.postData() || "",
      auth: request.headers().authorization,
    });
    let data: unknown;
    if (path === "/me")
      data = {
        user: {
          id: "u",
          email: "owner@example.com",
          name: "Lan Nguyen",
          alerts: true,
          digest: false,
        },
        company: {
          id: "c",
          name: "Binh Duong Wood Co.",
          origin: "Vietnam",
          transit: ["Singapore"],
          destination: "European Union",
          businessRole: "Manufacturer",
          currency: "USD",
        },
        role,
        onboarded: true,
      };
    else if (path === "/orders" || path === "/playbook/rules") data = [];
    else if (path === "/overview")
      data = {
        totalOrders: 0,
        countsByStatus: {},
        valueAtRiskByCurrency: {},
        nearestAffectedShipDate: null,
        sourcesCheckedAt: null,
      };
    else if (path === "/regulations") data = records;
    else if (path.startsWith("/regulations/")) {
      const record = records.find((item) => item.id === path.split("/")[2]);
      data = record && {
        ...record,
        versions: record.shared ? [record.latestVersion] : documents,
      };
    } else if (path === "/regulation-documents" && method === "POST") {
      const body = request.postData() || "";
      const isVersion = body.includes('name="regulationId"');
      const uploaded = {
        ...version,
        id: "doc-2",
        versionNumber: isVersion ? 2 : 1,
        regulationId: isVersion ? company.id : "new-rule",
      };
      documents = [uploaded, ...documents];
      records = isVersion
        ? records.map((record) =>
            record.id === company.id
              ? { ...record, versionCount: 2, latestVersion: uploaded }
              : record,
          )
        : [...records, { ...company, id: "new-rule", latestVersion: uploaded }];
      data = uploaded;
    } else if (path.endsWith("/file")) {
      await route.fulfill({
        body: "Original policy contents",
        contentType: "text/plain",
        headers: { "Content-Disposition": "attachment; filename=policy.txt" },
      });
      return;
    } else if (path.startsWith("/regulation-documents/"))
      data =
        documents.find((item) => item.id === path.split("/")[2]) ||
        shared.latestVersion;
    if (!data) {
      await route.fulfill({
        status: 404,
        json: {
          error: { code: "not_found", message: "Regulation not found." },
        },
      });
      return;
    }
    await route.fulfill({ json: { data, meta: {} } });
  });
  await page.route("**/api/impacts**", (route) =>
    route.fulfill({ json: { impacts: [] } }),
  );
  return requests;
}
test("library searches, filters and links exact versions to authenticated downloads", async ({
  page,
}, testInfo) => {
  const requests = await fixture(page);
  await page.goto("/#/workspace/regulations");
  await expect(
    page.getByRole("heading", { name: "Regulation library." }),
  ).toBeVisible();
  await expect(page.locator(".reg-card")).toHaveCount(2);
  await page.screenshot({
    path: testInfo.outputPath("library-desktop.png"),
    fullPage: true,
  });
  await page.getByLabel("Search regulations").fill("TIMBER-01");
  await expect(page.locator(".reg-card")).toHaveCount(1);
  await page.getByLabel("Collection").selectOption("shared");
  await expect(page.getByText("No matching regulations")).toBeVisible();
  await page.getByLabel("Search regulations").fill("");
  await expect(page.getByRole("heading", { name: shared.title })).toBeVisible();
  await page.getByLabel("Collection").selectOption("company");
  await page
    .getByRole("link", { name: "View regulation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Version history" }),
  ).toBeVisible();
  await page.getByRole("heading", { level: 3 }).getByRole("link").click();
  await expect(page.getByText("SHA-256 checksum")).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download file" }).click();
  expect((await downloaded).suggestedFilename()).toBe("policy.txt");
  expect(
    requests
      .filter((request) => request.path.includes("regulation"))
      .every((request) => request.auth === "Bearer dev:owner@example.com"),
  ).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("document-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
test("owners upload new regulations and versions using distinct multipart contracts", async ({
  page,
}) => {
  const requests = await fixture(page);
  await page.goto("/#/workspace/regulations/new");
  await page.getByLabel("Document title").fill("Timber sourcing policy");
  await page.getByLabel("Official ID").fill("TIMBER-02");
  await page.getByLabel("Source URL").fill("https://example.com/text");
  await page
    .getByLabel("Document file")
    .setInputFiles({
      name: "policy.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Policy text"),
    });
  await page.getByRole("button", { name: "Upload document" }).click();
  await expect(page).toHaveURL(/regulations\/new-rule$/);
  const first = requests.find((request) => request.method === "POST")!;
  expect(first.body).toContain('name="officialId"');
  expect(first.body).toContain("TIMBER-02");
  expect(first.body).not.toContain('name="regulationId"');
  await page.goto("/#/workspace/regulations/company-rule/upload");
  await expect(page.getByLabel("Official ID")).toHaveCount(0);
  await page
    .getByLabel("Document file")
    .setInputFiles({
      name: "updated.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Updated policy"),
    });
  await page.getByRole("button", { name: "Upload document" }).click();
  await expect(page).toHaveURL(/regulations\/company-rule$/);
  await expect(page.getByText("VERSION 2", { exact: true })).toBeVisible();
  const last = requests.filter((request) => request.method === "POST").at(-1)!;
  expect(last.body).toContain('name="regulationId"');
  expect(last.body).toContain("company-rule");
  expect(last.body).not.toContain('name="officialId"');
});
test("invalid files and server conflicts preserve the form for correction", async ({
  page,
}) => {
  const requests = await fixture(page);
  await page.goto("/#/workspace/regulations/new");
  await page.getByLabel("Document title").fill("Policy");
  await page
    .getByLabel("Document file")
    .setInputFiles({
      name: "bad.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("not a pdf"),
    });
  await page.getByRole("button", { name: "Upload document" }).click();
  await expect(page.getByRole("alert")).toContainText("not a valid PDF");
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(
    0,
  );
  await page.route("**/api/v1/regulation-documents", (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: "regulation_exists",
          message: "This official ID already exists. Upload a new version.",
        },
      },
    }),
  );
  await page
    .getByLabel("Document file")
    .setInputFiles({
      name: "policy.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Policy"),
    });
  await page.getByRole("button", { name: "Upload document" }).click();
  await expect(page.getByRole("alert")).toContainText("already exists");
  await expect(page.getByLabel("Document title")).toHaveValue("Policy");
  await expect(
    page.getByRole("button", { name: "Upload document" }),
  ).toBeEnabled();
});
test("viewers cannot upload through direct routes and shared texts stay read-only", async ({
  page,
}) => {
  const requests = await fixture(page, "viewer");
  await page.goto("/#/workspace/regulations");
  await expect(
    page.getByText("Read-only access.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Add regulation" })).toHaveCount(
    0,
  );
  await page.goto("/#/workspace/regulations/company-rule/upload");
  await expect(
    page.getByRole("heading", { name: "Read-only access" }),
  ).toBeVisible();
  await expect(page.locator("input[type=file]")).toHaveCount(0);
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(
    0,
  );
});
test("owners cannot add versions to shared texts, and unsafe source URLs are not linked", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/#/workspace/regulations/shared-rule/upload");
  await expect(
    page.getByText("Shared regulations are read-only.", { exact: false }),
  ).toBeVisible();
  await expect(page.locator("input[type=file]")).toHaveCount(0);
  await page.route("**/api/v1/regulation-documents/doc-1", (route) =>
    route.fulfill({
      json: {
        data: { ...version, sourceUrl: "javascript:alert(1)" },
        meta: {},
      },
    }),
  );
  await page.goto("/#/workspace/regulations/documents/doc-1");
  await expect(page.getByText("SHA-256 checksum")).toBeVisible();
  await expect(page.getByRole("link", { name: "Original source" })).toHaveCount(
    0,
  );
});
test("API errors offer retry, and download storage failures stay visible", async ({
  page,
}) => {
  await fixture(page);
  await page.route(
    "**/api/v1/regulations",
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: { message: "Library unavailable" } },
      }),
    { times: 1 },
  );
  await page.goto("/#/workspace/regulations");
  await expect(page.getByRole("alert")).toContainText("Library unavailable");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".reg-card")).toHaveCount(2);
  await page.route("**/api/v1/regulation-documents/doc-1/file", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "storage_not_configured",
          message: "Document storage is unavailable.",
        },
      },
    }),
  );
  await page.goto("/#/workspace/regulations/documents/doc-1");
  await page.getByRole("button", { name: "Download file" }).click();
  await expect(page.getByRole("alert")).toContainText("storage is unavailable");
  await expect(
    page.getByRole("button", { name: "Download file" }),
  ).toBeEnabled();
});
test("browser demo shows a sign-in gate without requesting company documents", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/v1/**", (route) => {
    calls++;
    return route.abort();
  });
  await page.addInitScript(() => sessionStorage.setItem("em-session", "demo"));
  await page.goto("/#/workspace/regulations");
  await expect(
    page.getByRole("heading", { name: "Sign in to your company workspace" }),
  ).toBeVisible();
  expect(calls).toBe(0);
});

test("a regulation document deep link survives Firebase-style account entry", async ({ page }) => {
  await fixture(page, "owner", false);
  await page.goto("/#/workspace/regulations/documents/doc-1");
  await page.getByLabel("Email", { exact: true }).fill("owner@example.com");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/regulations\/documents\/doc-1$/);
  await expect(page.getByText("SHA-256 checksum")).toBeVisible();
});
