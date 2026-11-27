// An order's next moves: the analysis report's buttons open the form that makes the change on
// the order's page, and saving analyses the order again. The API is mocked; the supplier
// record, the documents and the re-analysis come from the backend in a real session.
import { test, expect, type Page } from "@playwright/test";
import type { TradeMap } from "../src/api";
import { mapApiData } from "./map-api";

const account = {
  user: {
    id: "user-1",
    name: "Minh",
    email: "owner@example.com",
    alerts: true,
    digest: false,
  },
  company: {
    id: "company-1",
    name: "Furniture Co.",
    businessRole: "Manufacturer",
    origin: "Vietnam",
    destination: "United States",
    description: "Wooden furniture for US retailers.",
    currency: "USD",
  },
  role: "owner",
  onboarded: true,
};
const orderStatuses = [
  {
    code: "awaiting_analysis",
    label: "Awaiting analysis",
    description: "Not checked yet.",
    tone: "amber",
    manual: true,
    retired: false,
  },
  {
    code: "clear",
    label: "In the clear",
    description: "Every document is on file.",
    tone: "green",
    manual: true,
    retired: false,
  },
  {
    code: "exposed",
    label: "Action needed",
    description: "A document is missing.",
    tone: "red",
    manual: true,
    retired: false,
  },
];
const source = {
  regulationId: "reg-1",
  regulationTitle: "TSCA Title VI",
  officialId: "40 CFR 770",
  documentId: "doc-1",
  documentTitle: "40 CFR Part 770",
  versionNumber: 1,
  sourceUrl: null,
  quote: "Only certified composite wood products are permitted.",
};
const table = {
  id: "PO-3101",
  product: "Rubberwood dining table",
  supplier: "Tan Uyen Rubberwood",
  destination: "Los Angeles, US",
  valueMinor: 3840000,
  currency: "USD",
  shipDate: "2027-01-08",
  hsCode: "9403.60",
  status: "exposed",
};
const sideTable = {
  ...table,
  id: "PO-3120",
  product: "Acacia side table",
  supplier: "Phu Cat Acacia",
  hsCode: "",
};
// The supplier checks of PO-3101's US checklist, before and after the supplier is added.
const checks = (status: "unknown" | "on_file") =>
  [
    ["legality", "Timber legality evidence", []],
    ["species", "Species & harvest-country declaration", []],
    ["formaldehyde", "Formaldehyde emission test", ["TSCA Title VI"]],
  ].map(([kind, title, accepted]) => ({
    requirementKey: kind,
    title,
    level: "supplier",
    status,
    note:
      status === "unknown"
        ? "No document record for this supplier."
        : "On file",
    source,
    documentKind: kind,
    acceptedStandards: accepted,
  }));
const report = (
  id: string,
  order: typeof table,
  analysed: "before" | "after",
) => ({
  id,
  runId: "run-1",
  state: "pass",
  orderStatus: analysed === "after" ? "clear" : "exposed",
  blocked: false,
  createdAt: "2026-10-15T08:00:00Z",
  order,
  orderSource: null,
  market: "US",
  findings: order.hsCode
    ? checks(analysed === "after" ? "on_file" : "unknown")
    : [],
  missingData:
    analysed === "after"
      ? []
      : order.hsCode
        ? [`Add ${order.supplier} to the suppliers, with their documents.`]
        : ["Add the HS code, or ask for a suggested one."],
  daysUntilShip: 85,
  costLines: [],
  costTotals: {},
  problemCostTotals: {},
  unpricedCosts: [],
  rulesFired: [],
  rulesNotChecked: 0,
  suggestedAction:
    analysed === "after"
      ? { kind: "none", text: "Nothing to do for this order." }
      : {
          kind: "complete_data",
          text: order.hsCode
            ? `Add ${order.supplier} to the suppliers, with their documents.`
            : "Add the HS code, or ask for a suggested one.",
        },
  audit: { passed: true, problems: [] },
  review: null,
  messageBlockedReason:
    analysed === "after" ? null : "Complete the order's data first.",
  feedback: { useful: 0, notUseful: 0, mine: null, myNote: null },
});

// GET /trade-risk/orders/{id}: PO-3101's pair is scored by the job after the first read.
const pendingRisk = {
  orderId: "PO-3101",
  market: "US",
  exporter: "VN",
  hs6: "940360",
  status: "pending",
  level: null,
  score: null,
  percentile: null,
  reasons: [],
  note: null,
  backfillStarted: true,
  modelVersion: null,
  dataFrom: null,
  dataTo: null,
  dataSource: null,
  scoredAt: null,
  similarCases: [],
  sources: [
    "Source: UN Comtrade.",
    "Past cases: World Bank Temporary Trade Barriers Database.",
  ],
};
const scoredRisk = {
  ...pendingRisk,
  status: "scored",
  level: "high",
  score: 0.031,
  percentile: 0.996,
  reasons: [
    {
      feature: "cases_market_hs4_5y",
      text: "The US opened 3 cases on related products in the last 5 years.",
    },
    {
      feature: "exporter_share",
      text: "Vietnam is a large supplier of this product to the US.",
    },
  ],
  dataFrom: "2025-09",
  dataTo: "2026-08",
  dataSource: "comtrade",
  scoredAt: "2026-11-26T08:00:00Z",
  similarCases: [
    {
      caseId: "USA-AD-1612",
      kind: "AD",
      market: "US",
      exporter: "CN",
      hs6: "940360",
      year: 2019,
      product: "Wooden bedroom furniture",
      outcome: "duty imposed",
      dutyPct: 216,
    },
  ],
};

async function fixture(page: Page) {
  const requests: { method: string; path: string; body: any }[] = [];
  let supplierSaved = false;
  let riskReads = 0;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1", "");
    const method = request.method();
    const body = request.postDataJSON?.() ?? null;
    requests.push({ method, path, body });
    const status = supplierSaved ? "clear" : "exposed";
    let data: unknown;
    const tradeMap: TradeMap = {
        markets: [],
        orders: [
          {
            order: table,
            placement: {
              city: "Los Angeles",
              country: "US",
              market: "US",
              location: null,
              approximate: true,
            },
            checks: checks("unknown"),
            gapCount: 0,
          },
        ],
        suppliers: [
          {
            id: null,
            name: "Tan Uyen Rubberwood",
            place: null,
            country: null,
            location: null,
            supplies: null,
            documents: null,
            orderIds: ["PO-3101"],
          },
        ],
        sites: [],
        observations: [],
        documentKinds: [
          { kind: "legality", label: "Timber legality evidence" },
          { kind: "geolocation", label: "Plot-level geolocation" },
          { kind: "species", label: "Species & harvest-country declaration" },
          { kind: "formaldehyde", label: "Formaldehyde emission test" },
          { kind: "chain", label: "Chain-of-custody certificate" },
        ],
        countries: [{ code: "VN", numericCode: "704", name: "Vietnam" }],
        homeCountryIds: [],
        checkRadiusKm: 25,
      };
    const fromMap = mapApiData(route, tradeMap);
    if (fromMap !== undefined) data = fromMap;
    else if (path === "/me") data = account;
    else if (path === "/orders") data = [{ ...table, status }, sideTable];
    else if (path === "/overview")
      data = {
        totalOrders: 2,
        countsByStatus: {
          exposed: supplierSaved ? 1 : 2,
          clear: supplierSaved ? 1 : 0,
        },
        valueAtRiskByCurrency: {},
        nearestAffectedShipDate: null,
        sourcesCheckedAt: null,
      };
    else if (path === "/order-statuses") data = orderStatuses;
    else if (path === "/orders/PO-3101")
      data = {
        order: { ...table, status },
        source: null,
        exposures: [],
        latestReportId: supplierSaved ? "report-2" : "report-1",
        statusChanges: [],
      };
    else if (path === "/orders/PO-3120")
      data = {
        order: sideTable,
        source: null,
        exposures: [],
        latestReportId: "report-3",
        statusChanges: [],
      };
    else if (path === "/trade-risk/orders/PO-3101")
      // A new pair: pending on the first read, scored on the next.
      data = (riskReads += 1) === 1 ? pendingRisk : scoredRisk;
    else if (path === "/trade-risk/orders/PO-3120")
      data = {
        ...pendingRisk,
        hs6: null,
        status: "no_data",
        note: "The HS code needs at least 6 digits to score.",
      };
    else if (path === "/reports/report-1")
      data = report("report-1", table, "before");
    else if (path === "/reports/report-2")
      data = report("report-2", { ...table, status: "clear" }, "after");
    else if (path === "/reports/report-3")
      data = report("report-3", sideTable, "before");
    else if (path === "/suppliers" && method === "POST") {
      supplierSaved = true;
      data = {
        ...body,
        id: "supplier-1",
        documents: body.documents.map((d: any) => ({ ...d, label: d.kind })),
        analysedOrderIds: ["PO-3101", "PO-3102"],
      };
    } else if (
      path === "/playbook/rules" ||
      path.endsWith("/supplier-messages") ||
      path.endsWith("/solutions")
    )
      data = [];
    else {
      await route.fulfill({
        status: 404,
        json: { error: { message: `Unexpected API ${method} ${path}` } },
      });
      return;
    }
    await route.fulfill({ json: { data, meta: {} } });
  });
  await page.route("**/api/v1/news-alerts**", (route) =>
    route.fulfill({ json: { data: { impacts: [] } } }),
  );
  return requests;
}

async function login(page: Page) {
  await page.goto("/#/login");
  await page.getByLabel("Email", { exact: true }).fill("owner@example.com");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/#\/workspace/);
}

test("a missing supplier record is added from the order, with the documents its checklist asks for", async ({
  page,
}) => {
  const requests = await fixture(page);
  await login(page);
  await page.goto("/#/workspace/orders/PO-3101");
  const analysis = page.getByRole("region", { name: "Analysis report" });
  await expect(
    analysis.getByRole("heading", {
      name: "Add Tan Uyen Rubberwood to the suppliers, with their documents.",
    }),
  ).toBeVisible();

  await analysis
    .getByRole("button", { name: "Add Tan Uyen Rubberwood with its documents" })
    .click();
  await expect(analysis.getByLabel("Name")).toHaveValue("Tan Uyen Rubberwood");
  // The documents PO-3101's checklist asks for come first, with what it accepts.
  await expect(analysis.getByText("Needed for PO-3101")).toHaveCount(3);
  await expect(analysis.locator(".tm-doc-field").first()).toContainText(
    "Timber legality evidence",
  );
  await expect(analysis.getByText("Accepted: TSCA Title VI.")).toBeVisible();
  await expect(
    analysis.getByText("Paste latitude and longitude from a map app."),
  ).toBeVisible();

  await analysis
    .getByRole("checkbox", { name: /Timber legality evidence/ })
    .check();
  await analysis
    .getByLabel("Timber legality evidence: what's on file")
    .fill("VNTLAS legality dossier");
  await analysis
    .getByRole("checkbox", { name: /Formaldehyde emission test/ })
    .check();
  await analysis
    .getByLabel("Formaldehyde emission test: what's on file")
    .fill("TSCA certificate");
  await expect(
    analysis.getByLabel("Formaldehyde emission test: test standards"),
  ).toHaveAttribute("placeholder", "Test standards, e.g. TSCA Title VI");
  await analysis
    .getByLabel("Formaldehyde emission test: test standards")
    .fill("TSCA Title VI");
  await analysis.getByRole("button", { name: "Add supplier" }).click();

  // The backend analysed every order that names the supplier; the page shows the new report.
  await expect(
    page.getByText(
      "Tan Uyen Rubberwood saved. PO-3101 and PO-3102 analysed again.",
    ),
  ).toBeVisible();
  await expect(
    analysis.getByRole("heading", { name: "Nothing to do for this order." }),
  ).toBeVisible();
  await expect(analysis.getByRole("group", { name: "Next moves" })).toHaveCount(
    0,
  );
  const created = requests.find(
    (r) => r.method === "POST" && r.path === "/suppliers",
  );
  expect(created?.body).toMatchObject({
    name: "Tan Uyen Rubberwood",
    location: null,
    documents: [
      { kind: "legality", detail: "VNTLAS legality dossier", standards: [] },
      {
        kind: "formaldehyde",
        detail: "TSCA certificate",
        standards: ["TSCA Title VI"],
      },
    ],
  });
});

test("a missing HS code opens the order's form at that field, also at phone width", async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto("/#/workspace/orders/PO-3120");
  const moves = page.getByRole("group", { name: "Next moves" });
  await expect(moves.getByRole("button")).toHaveText(["Add the HS code"]);
  await moves.getByRole("button", { name: "Add the HS code" }).click();
  const form = page.getByRole("form", { name: "Edit PO-3120" });
  await expect(form).toBeVisible();
  await expect(form.locator('input[name="hsCode"]')).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("an order's trade defence risk is scored on first read, then shows its level, reasons and past cases", async ({
  page,
}) => {
  await fixture(page);
  await login(page);
  await page.goto("/#/workspace/orders/PO-3101");
  const risk = page.getByRole("region", { name: "Trade defence risk" });
  await expect(
    risk.getByText("Scoring this market and product for the first time."),
  ).toBeVisible();
  // The panel asks again every 10 seconds while the pair is pending.
  await expect(risk.locator(".risk-level.high")).toHaveText("High", {
    timeout: 15_000,
  });
  await expect(risk.getByText("in the top 1% of trade flows")).toBeVisible();
  await expect(
    risk.getByText("Vietnam is a large supplier of this product to the US."),
  ).toBeVisible();
  await expect(
    risk.getByText(
      "Anti-dumping case by the United States on Wooden bedroom furniture from China, 2019",
    ),
  ).toBeVisible();
  await expect(risk.getByText("duty imposed (216%)")).toBeVisible();
  await expect(
    risk.getByText("Import figures: UN Comtrade, Sep 2025 to Aug 2026."),
  ).toBeVisible();
  await expect(risk.getByText(/Source: UN Comtrade\./)).toBeVisible();

  await page.goto("/#/workspace/orders/PO-3120");
  await expect(
    page
      .getByRole("region", { name: "Trade defence risk" })
      .getByText("The HS code needs at least 6 digits to score."),
  ).toBeVisible();
});
