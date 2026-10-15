import { test, expect, type Page } from "@playwright/test";
import type { TradeMap } from "../src/api";

const order = {
  id: "PO|42",
  product: "Sample goods",
  supplier: "Sample supplier",
  destination: "Rotterdam, NL",
  valueMinor: 2400000,
  currency: "USD",
  shipDate: "2026-12-10",
  hsCode: "4412.33",
  status: "awaiting_analysis" as const,
};
const account = {
  user: {
    id: "test-user",
    name: "Test Owner",
    email: "owner@example.com",
    alerts: true,
    digest: false,
  },
  company: {
    id: "test-company",
    name: "Globe test company",
    businessRole: "Manufacturer",
    origin: "Vietnam",
    destination: "European Union",
    currency: "USD",
    description: "Synthetic globe test data",
  },
  role: "owner",
  onboarded: true,
};
const mapData: TradeMap = {
  markets: [
    {
      code: "EU",
      name: "European Union",
      shortName: "EU",
      hub: { latitude: 50, longitude: 8 },
      countryIds: ["276", "250", "528"],
      searchTerms: [],
    },
    {
      code: "US",
      name: "United States",
      shortName: "US",
      hub: { latitude: 38, longitude: -98 },
      countryIds: ["840"],
      searchTerms: [],
    },
    {
      code: "JP",
      name: "Japan",
      shortName: "Japan",
      hub: { latitude: 36, longitude: 138 },
      countryIds: ["392"],
      searchTerms: [],
    },
  ],
  orders: [
    {
      order,
      placement: {
        city: "Rotterdam",
        country: "NL",
        market: "EU",
        location: { latitude: 51.92, longitude: 4.4 },
        approximate: false,
      },
      checks: [],
      gapCount: 0,
    },
  ],
  suppliers: [
    {
      id: "supplier-1",
      name: "Sample supplier",
      place: "Vietnam",
      country: "VN",
      location: { latitude: 11.54, longitude: 106.9 },
      supplies: "Sample goods",
      documents: [],
      orderIds: [order.id],
    },
  ],
  sites: [
    {
      id: "site-1",
      key: "factory",
      kind: "factory",
      name: "Sample factory",
      shortName: "Factory",
      place: "Vietnam",
      country: "VN",
      location: { latitude: 10.8, longitude: 106.7 },
      note: "Synthetic test location",
      isRouteOrigin: true,
    },
  ],
  observations: [
    {
      id: "flood-1",
      kind: "flood",
      title: "Sample flood",
      place: "Vietnam",
      center: { latitude: 11.54, longitude: 106.9 },
      radiusKm: 2,
      areaKm2: 3,
      observedOn: "2026-10-01",
      sensor: "Sample radar observation",
      confidence: "high",
      confidenceNote: "Synthetic data",
      extent: {
        type: "Polygon",
        coordinates: [
          [
            [106.88, 11.52],
            [106.92, 11.52],
            [106.92, 11.56],
            [106.88, 11.56],
            [106.88, 11.52],
          ],
        ],
      },
      isSample: true,
      sourceUrl: null,
      nearby: [
        {
          type: "supplier",
          ref: "Sample supplier",
          name: "Sample supplier",
          distanceKm: 0,
        },
      ],
    },
  ],
  documentKinds: [{ kind: "legality", label: "Timber legality evidence" }],
  countries: [
    { code: "KH", numericCode: "116", name: "Cambodia" },
    { code: "VN", numericCode: "704", name: "Vietnam" },
  ],
  homeCountryIds: ["704"],
  checkRadiusKm: 25,
};
async function openMap(
  page: Page,
  options: {
    noOrigin?: boolean;
    fail?: boolean;
    hash?: string;
    origin?: string;
    role?: "owner" | "viewer";
    writes?: { method: string; path: string; body: any }[];
  } = {},
) {
  const comparisons: URL[] = [];
  // Saved suppliers and sites show up when the map reloads.
  const current: TradeMap = structuredClone(mapData);
  await page.route("**/api/impacts**", (r) =>
    r.fulfill({ json: { impacts: [], scan: null } }),
  );
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/v1", "");
    let data: unknown;
    if (path === "/me")
      data = {
        ...account,
        role: options.role ?? account.role,
        company: {
          ...account.company,
          origin: options.origin ?? account.company.origin,
        },
      };
    else if (path === "/orders") data = [order];
    else if (path === "/playbook/rules") data = [];
    else if (path === "/overview")
      data = {
        totalOrders: 1,
        countsByStatus: {
          awaiting_analysis: 1,
          clear: 0,
          exposed: 0,
          needs_data: 0,
        },
        valueAtRiskByCurrency: {},
        nearestAffectedShipDate: null,
        sourcesCheckedAt: null,
      };
    else if (path === "/trade-map") {
      if (options.fail)
        return route.fulfill({
          status: 503,
          json: { error: { message: "Map service unavailable" } },
        });
      data = { ...current, sites: options.noOrigin ? [] : current.sites };
    } else if (path === "/suppliers/supplier-1/documents") {
      options.writes?.push({ method: "POST", path, body: null });
      data = {
        id: "upload-1",
        supplierId: "supplier-1",
        filename: "fsc.pdf",
        contentType: "application/pdf",
        sizeBytes: 9,
        status: "draft",
        extracted: {
          kind: "legality",
          documentNumber: "SGS-COC-001234",
          issuer: "SGS",
          issuedOn: "2025-12-15",
          expiresOn: "2026-12-15",
          standards: ["FSC-STD-40-004"],
          detail: "FSC chain of custody SGS-COC-001234",
          notes: "The stamp is faint.",
        },
        createdAt: "2026-10-15T08:00:00Z",
        confirmedAt: null,
      };
    } else if (path === "/supplier-documents/upload-1/confirm") {
      const body = route.request().postDataJSON();
      options.writes?.push({ method: "POST", path, body });
      current.suppliers[0].documents = [
        { ...body, label: "Timber legality evidence", fromUpload: true },
      ];
      data = { id: "doc-1", supplierId: "supplier-1", uploadId: "upload-1", ...body };
    } else if (path === "/suppliers" || path.startsWith("/sites/")) {
      const method = route.request().method();
      const body = route.request().postDataJSON();
      options.writes?.push({ method, path, body });
      if (path === "/suppliers") {
        data = { id: "supplier-2", ...body, documents: [] };
        current.suppliers.push({
          ...(data as TradeMap["suppliers"][number]),
          orderIds: [],
        });
      } else {
        data = { ...current.sites[0], ...body };
        current.sites[0] = data as TradeMap["sites"][number];
      }
    } else if (path === "/trade-map/compare") {
      comparisons.push(url);
      if (url.searchParams.get("shipDate")) {
        data = {
          orderId: order.id,
          kind: "ship_date",
          fromMarket: "EU",
          toMarket: "EU",
          fromShipDate: order.shipDate,
          toShipDate: url.searchParams.get("shipDate"),
          reuse: [],
          reevaluate: [
            {
              title: "Formaldehyde emission test",
              note: "Listed from 2026-08-06. It applies on the new date.",
              tag: "New",
            },
          ],
          unknown: [
            {
              title: "Arrival date",
              note: "Transit time is not in this dataset.",
            },
          ],
          dropped: [],
          assumptions: ["Only the checklist's effective dates are compared."],
        };
      } else if (url.searchParams.get("via")) {
        data = {
          orderId: order.id,
          kind: "route",
          fromMarket: "EU",
          toMarket: "EU",
          via: url.searchParams.get("via"),
          viaName: "Singapore",
          distanceKm: 10800,
          routePoints:
            url.searchParams.get("via") === "direct"
              ? [
                  mapData.sites[0].location,
                  mapData.orders[0].placement.location,
                ]
              : [
                  mapData.sites[0].location,
                  { latitude: 1.26, longitude: 103.84 },
                  mapData.orders[0].placement.location,
                ],
          reuse: [],
          reevaluate: [
            {
              title: "Proof of origin",
              note: "A stop in Singapore can change the consignment rule.",
              tag: "Changes",
            },
          ],
          unknown: [{ title: "Freight cost", note: "No rate card is stored." }],
          dropped: [],
          assumptions: [
            "About 10800 km is the great-circle length via Singapore. It is not a voyage and not a freight quote.",
          ],
        };
      } else
        data = {
          orderId: order.id,
          fromMarket: "EU",
          toMarket: url.searchParams.get("market"),
          reuse: [],
          reevaluate: [
            {
              title: "Shipment declaration",
              note: "Prepare evidence for this shipment",
              tag: "Prepare",
            },
          ],
          unknown: [],
          dropped: ["Old market checklist item"],
        };
    } else
      return route.fulfill({ status: 404, json: { error: { message: path } } });
    await route.fulfill({ json: { data, meta: {} } });
  });
  await page.goto("/#/login");
  await page.getByLabel("Email", { exact: true }).fill("owner@example.com");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/#\/workspace$/);
  if (options.origin)
    await expect(page.getByText(`${options.origin} to`)).toBeVisible();
  await page.goto("/#/workspace/" + (options.hash ?? "map"));
  return comparisons;
}

test("globe rotates, pauses, selects company data and preserves regional detail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openMap(page);
  const globe = page.getByRole("group", { name: "Interactive 3D trade globe" });
  await expect(globe.locator("canvas")).toBeVisible();
  await expect(globe).toHaveAttribute("data-playing", "true");
  await expect(globe.getByText("1 TRADE CONNECTION")).toBeVisible();
  const origin = globe.getByRole("button", { name: /Your production sites/ });
  await expect(origin).toBeVisible();
  const before = await origin.getAttribute("style");
  await expect.poll(() => origin.getAttribute("style")).not.toBe(before);
  await globe.getByRole("button", { name: "Pause globe animation" }).click();
  await expect(globe).toHaveAttribute("data-playing", "false");
  await page.getByRole("button", { name: "Routes", exact: true }).click();
  await expect(globe.getByText("0 TRADE CONNECTIONS")).toBeVisible();
  await page.getByRole("button", { name: "Routes", exact: true }).click();
  await expect(globe.getByText("1 TRADE CONNECTION")).toBeVisible();
  await globe
    .getByRole("button", { name: "European Union: 1 order", exact: true })
    .click();
  await expect(page.locator(".tm-panel")).toContainText(order.id);
  await page.getByRole("tab", { name: "Production", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Trade map, Production" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Supplier Sample supplier, Vietnam/ })
    .click();
  await expect(page.locator(".tm-panel h2")).toHaveText("Sample supplier.");
  await page.getByRole("tab", { name: "World", exact: true }).click();
  await expect(globe.locator("canvas")).toBeVisible();
  expect(errors).toEqual([]);
});

test("comparison preserves IDs containing delimiters and route visibility in both projections", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const comparisons = await openMap(page, { hash: "map/order/PO%7C42" });
  const globe = page.getByRole("group", { name: "Interactive 3D trade globe" });
  await expect(globe).toHaveAttribute("data-playing", "false");
  await page
    .getByRole("group", { name: "Market to compare with" })
    .getByRole("button", { name: "United States" })
    .click();
  await expect(
    page.locator(".tm-compare b").filter({ hasText: "Shipment declaration" }),
  ).toBeVisible();
  expect(comparisons.at(-1)?.searchParams.get("orderId")).toBe("PO|42");
  await expect(globe.getByText("2 TRADE CONNECTIONS")).toBeVisible();
  await page.getByRole("button", { name: "Routes", exact: true }).click();
  await expect(globe.getByText("0 TRADE CONNECTIONS")).toBeVisible();
  await page.getByRole("button", { name: "2D map ↗" }).click();
  await expect(page.locator(".tm-arc")).toHaveCount(0);
  await page.getByRole("button", { name: "Routes", exact: true }).click();
  await expect(page.locator(".tm-arc.scenario")).toHaveCount(2);
  await expect(
    page.getByText(/Not listed in the current United States checklist/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Ship date", exact: true }).click();
  await page.getByLabel("Proposed ship date").fill("2027-02-01");
  await expect(page.getByText("Formaldehyde emission test")).toBeVisible();
  await expect(
    page.getByText("Only the checklist's effective dates are compared."),
  ).toBeVisible();
  expect(comparisons.at(-1)?.searchParams.get("shipDate")).toBe("2027-02-01");
  await page.getByRole("button", { name: "Route", exact: true }).click();
  await page.getByRole("button", { name: "Singapore", exact: true }).click();
  await expect(page.getByText(/not a freight quote/)).toBeVisible();
  expect(comparisons.at(-1)?.searchParams.get("via")).toBe("SG");
  await expect(
    page.getByText("Proposed route · Production → Singapore → Rotterdam"),
  ).toBeVisible();
  await expect(page.locator(".tm-arc.scenario.target")).toHaveCount(2);
  await expect(page.locator(".tm-route-stop text")).toHaveText([
    "Singapore",
    "Rotterdam",
  ]);
  await page.getByRole("button", { name: "3D globe ↗" }).click();
  await expect(globe.getByText("2 TRADE CONNECTIONS")).toBeVisible();
  await expect(
    globe.getByRole("button", { name: "Proposed stop: Singapore" }),
  ).toBeAttached();
  await page.getByRole("button", { name: "Routes", exact: true }).click();
  await expect(page.getByText(/Proposed route ·/)).toHaveCount(0);
  await expect(
    globe.getByRole("button", { name: "Proposed stop: Singapore" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Routes", exact: true }).click();
  await page.getByRole("button", { name: "Direct", exact: true }).click();
  await expect(
    page.getByText("Proposed route · Production → Rotterdam"),
  ).toBeVisible();
  await expect(
    globe.getByRole("button", { name: "Proposed stop: Singapore" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Ship date", exact: true }).click();
  await expect(page.getByText(/Proposed route ·/)).toHaveCount(0);
});

test("sample flood drafts remain explicitly fictional when copied out of the map", async ({
  page,
}) => {
  await openMap(page);
  await page
    .getByRole("button", { name: /SATELLITE.*SAMPLE.*Sample flood/ })
    .click();
  await page
    .getByRole("button", { name: "Draft a check-in", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Check-in message to Sample supplier" }),
  ).toHaveValue(/fictional exercise, not evidence of an actual flood/);
});

test("mobile missing-origin state and WebGL fallback stay usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      type: string,
      ...args: any[]
    ) {
      if (type.startsWith("webgl")) return null;
      return (original as any).call(this, type, ...args);
    } as typeof original;
  });
  await openMap(page, { noOrigin: true });
  await expect(
    page.getByText("3D is unavailable on this device. Showing the 2D map."),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Trade map, World" }),
  ).toBeVisible();
  await expect(page.locator(".tm-arc")).toHaveCount(1);
  await expect(
    page.getByText(/Lines run from Vietnam on your company profile/),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("profile origin connects markets when no site is recorded", async ({
  page,
}) => {
  await openMap(page, { noOrigin: true });
  await expect(
    page.getByText(/Lines run from Vietnam on your company profile/),
  ).toBeVisible();
  await expect(page.getByText("1 TRADE CONNECTION")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Approximate start in Vietnam/ }),
  ).toBeVisible();
  await expect(page.getByText(/Your production sites/)).toHaveCount(0);
});

test("an unnamed origin does not invent a route start", async ({ page }) => {
  await openMap(page, { noOrigin: true, origin: "Other" });
  await expect(page.getByText(/No route origin is recorded yet/)).toBeVisible();
  await expect(page.getByText("0 TRADE CONNECTIONS")).toBeVisible();
});

test("failed map reads never show sample data", async ({ page }) => {
  await openMap(page, { fail: true });
  await expect(page.getByText("Map service unavailable")).toBeVisible();
  await expect(page.locator(".tm-globe")).toHaveCount(0);
});

test("editors add a supplier from a map click or typed coordinates", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  const writes: { method: string; path: string; body: any }[] = [];
  await openMap(page, { writes });
  await page.getByRole("button", { name: "Add supplier" }).click();
  const form = page.locator(".tm-panel form");
  await expect(form.locator("h2")).toHaveText("Add a supplier.");
  // The form switches to the 2D map of the company's own area.
  const canvas = page.getByRole("group", { name: "Trade map, Production" });
  await expect(canvas).toBeVisible();
  await canvas.click({ position: { x: 300, y: 200 } });
  await expect(page.locator(".tm-pin")).toBeVisible();
  await expect(form.getByLabel("Location (optional)")).toHaveValue(
    /^-?\d+(\.\d+)?, -?\d+(\.\d+)?$/,
  );

  await form.getByLabel("Name").fill("Kampot Timber");
  await form.getByLabel("Location (optional)").fill("abc");
  await expect(form.getByText("Write latitude, then longitude")).toBeVisible();
  await form.getByLabel("Location (optional)").fill("10.61, 104.18");
  await form.getByLabel("Country").selectOption("KH");
  await form.getByLabel("Timber legality evidence").check();
  await form
    .getByLabel("Timber legality evidence: what's on file")
    .fill("Legality dossier");
  await form.getByRole("button", { name: "Add supplier" }).click();

  await expect(page.locator(".tm-panel h2")).toHaveText("Kampot Timber.");
  expect(writes).toEqual([
    {
      method: "POST",
      path: "/suppliers",
      body: {
        name: "Kampot Timber",
        place: null,
        country: "KH",
        location: { latitude: 10.61, longitude: 104.18 },
        supplies: null,
        contactName: null,
        contactEmail: null,
        documents: [
          {
            kind: "legality",
            detail: "Legality dossier",
            standards: [],
            documentNumber: null,
            issuer: null,
            expiresOn: null,
          },
        ],
      },
    },
  ]);
});

test("editors edit a site and viewers see no edit controls", async ({
  page,
}) => {
  const writes: { method: string; path: string; body: any }[] = [];
  await openMap(page, { writes });
  await page.getByRole("button", { name: /Sample factory/ }).click();
  await page.getByRole("button", { name: "Edit site" }).click();
  const form = page.locator(".tm-panel form");
  await expect(form.getByLabel("Location")).toHaveValue("10.8, 106.7");
  await expect(form.getByLabel("Order routes start here")).toBeChecked();
  await form.getByLabel("Name").fill("Binh Duong factory");
  await form.getByRole("button", { name: "Save site" }).click();
  await expect(page.locator(".tm-panel h2")).toHaveText("Binh Duong factory.");
  expect(writes).toEqual([
    {
      method: "PATCH",
      path: "/sites/site-1",
      body: expect.objectContaining({
        name: "Binh Duong factory",
        shortName: "Factory",
        location: { latitude: 10.8, longitude: 106.7 },
        isRouteOrigin: true,
      }),
    },
  ]);

  await page.getByRole("button", { name: "Edit site" }).click();
  await page.getByRole("button", { name: "Delete site" }).click();
  await expect(page.locator(".tm-confirm")).toContainText(
    "Routes start here",
  );
  await page.getByRole("button", { name: "Keep it" }).click();
  await expect(page.locator(".tm-confirm")).toHaveCount(0);
});

test("viewers can't add or edit places", async ({ page }) => {
  await openMap(page, { role: "viewer" });
  await expect(page.locator(".tm-panel h2")).toHaveText("Pick a place.");
  await expect(page.getByRole("button", { name: "Add supplier" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add site" })).toHaveCount(0);
  await page.getByRole("button", { name: /Sample factory/ }).click();
  await expect(page.locator(".tm-panel h2")).toHaveText("Sample factory.");
  await expect(page.getByRole("button", { name: "Edit site" })).toHaveCount(0);
});

test("editors upload a supplier certificate and confirm what AI read", async ({
  page,
}) => {
  const writes: { method: string; path: string; body: any }[] = [];
  await openMap(page, {
    writes,
    hash: "map/supplier/" + encodeURIComponent("Sample supplier"),
  });
  await expect(page.locator(".tm-panel h2")).toHaveText("Sample supplier.");
  await page
    .getByLabel("Upload a certificate for Sample supplier")
    .setInputFiles({
      name: "fsc.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 "),
    });
  const form = page.locator(".tm-upload-form");
  await expect(form.getByText("Hard to read: The stamp is faint.")).toBeVisible();
  await expect(form.getByLabel("Document number (optional)")).toHaveValue(
    "SGS-COC-001234",
  );
  await expect(form.getByLabel("Expires on (optional)")).toHaveValue("2026-12-15");
  await form.getByLabel("Issued by (optional)").fill("SGS Vietnam");
  await form.getByRole("button", { name: "Confirm certificate" }).click();
  await expect(
    page.getByText(/expires 2026-12-15 · from an uploaded certificate/),
  ).toBeVisible();
  expect(writes).toEqual([
    { method: "POST", path: "/suppliers/supplier-1/documents", body: null },
    {
      method: "POST",
      path: "/supplier-documents/upload-1/confirm",
      body: {
        kind: "legality",
        detail: "FSC chain of custody SGS-COC-001234",
        standards: ["FSC-STD-40-004"],
        documentNumber: "SGS-COC-001234",
        issuer: "SGS Vietnam",
        expiresOn: "2026-12-15",
      },
    },
  ]);
});
