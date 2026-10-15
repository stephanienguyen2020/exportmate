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
// As the backend's order_statuses table names them; "Cleared to ship" isn't a built-in label,
// so the tests can tell the workspace reads them from the API. Needs data is retired: orders
// analysed before still carry it, but it is never a filter or a choice.
const orderStatuses = [
  { code: "awaiting_analysis", label: "Awaiting analysis", description: "Not checked yet.", tone: "amber", manual: true, retired: false },
  { code: "clear", label: "Cleared to ship", description: "Every document is on file.", tone: "green", manual: true, retired: false },
  { code: "exposed", label: "Action needed", description: "A document is missing.", tone: "red", manual: true, retired: false },
  { code: "needs_data", label: "Needs data", description: "No longer used.", tone: "amber", manual: false, retired: true },
];
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
const citation = tradeMap.orders[0].checks[0].source;
const analysisReport = () => ({
  id: "report-1",
  runId: "run-1",
  state: "needs_human_review",
  orderStatus: "exposed",
  blocked: false,
  createdAt: "2026-10-15T08:00:00Z",
  order,
  orderSource: { importId: "import-1", rowNumber: 2 },
  market: "EU",
  findings: [
    { ...tradeMap.orders[0].checks[0] },
    {
      requirementKey: "legality",
      title: "Timber legality evidence",
      level: "supplier",
      status: "on_file",
      note: "VNTLAS dossier",
      source: citation,
    },
  ],
  missingData: [],
  daysUntilShip: 98,
  costLines: [
    {
      kind: "delay",
      label: "Possible delay while the records are gathered",
      requirementKey: "eudr-geolocation",
      quantity: 14,
      unitAmountMinor: 8571,
      baseAmountMinor: null,
      ratePercent: null,
      amountMinor: 119994,
      currency: "EUR",
      formula: "14 days × EUR 85.71",
      basis: [{ type: "company_setting", label: "Your delay cost per day", settingKey: "delay_per_day" }],
    },
  ],
  costTotals: { EUR: 119994 },
  problemCostTotals: { EUR: 119994 },
  unpricedCosts: [
    {
      kind: "duty",
      label: "Import duty",
      requirementKey: "duty",
      reason: "The rate changes on 2027-01-01, on or before the ship date: recheck it.",
      source: citation,
    },
  ],
  rulesFired: [
    {
      ruleId: "rule-1",
      text: "Server policy",
      action: "owner_review",
      note: "Check with the buyer first",
      conditions: ["Market is European Union"],
    },
  ],
  rulesNotChecked: 0,
  suggestedAction: {
    kind: "request_documents",
    text: "Ask Server Supplier for the plot geolocation.",
    requestBy: "2026-12-10",
  },
  audit: { passed: true, problems: [] },
  review: null,
  messageBlockedReason: "A playbook rule sent this report to the owner. It needs their review first.",
  feedback: { useful: 0, notUseful: 0, mine: null, myNote: null },
});
const runSteps = ["relevance", "exposure", "cost", "playbook", "plan", "auditor"].map(
  (name) => ({ name, summary: `${name} done` }),
);
const runOf = (reports: unknown[]) => ({
  id: "run-1",
  status: "done",
  orderCount: reports.length,
  steps: runSteps,
  playbookRevision: 3,
  costSettings: [],
  error: null,
  createdAt: "2026-10-15T08:00:00Z",
  finishedAt: "2026-10-15T08:00:02Z",
  reports,
});
const noCode = { ...order, id: "NOCODE-1", hsCode: "", product: "Oak dining chair" };
const suggestion = (id: string, hsCode: string) => ({
  id,
  hsCode,
  description: `Official wording of ${hsCode}`,
  reason: `Why ${hsCode} fits`,
  basedOn: [
    { type: "order", ref: "PO-1", text: "Oak chair", hsCode: "9401.61" },
    { type: "heading", ref: hsCode, text: "Wooden furniture" },
  ],
  status: "pending",
  createdAt: "2026-10-15T08:00:00Z",
  decidedAt: null,
});
const ruleFields = {
  fields: [
    {
      key: "market",
      label: "Market",
      type: "text",
      ops: { equals: "is", not_equals: "is not", contains: "contains" },
      options: [{ value: "EU", label: "European Union" }],
    },
    {
      key: "days_until_ship",
      label: "Days until ship date",
      type: "number",
      ops: { less_than: "less than", greater_than: "more than", equals: "is" },
      options: null,
    },
    {
      key: "estimated_cost",
      label: "Estimated cost of the problems (without duties)",
      type: "money",
      ops: { less_than: "less than", greater_than: "more than" },
      options: null,
    },
  ],
  actions: {
    flag: "Add a note to the report",
    owner_review: "Send the report to the owner (needs human review)",
    block: "Block messages from this report",
  },
  noValueOps: ["is_empty", "is_not_empty"],
};
const costSetting = (key: string, label: string, unit: string, value: number) => ({
  key,
  label,
  unit,
  value,
  source: "default",
  defaultUnit: unit,
  defaultValue: value,
});
const requirement = (id: string, title: string, quoteVerified: boolean) => ({
  id,
  marketCode: "EU",
  requirementKey: id,
  title,
  level: "supplier",
  documentKind: "legality",
  acceptedStandards: [],
  form: null,
  hsPrefixes: ["9403"],
  why: `${title} applies to wooden furniture.`,
  sourceQuote: `Quote for ${title}.`,
  quoteVerified,
  effectiveOn: null,
  dutyRatePercent: null,
  status: "draft",
  shared: false,
  regulationDocumentId: "doc-c1",
  reviewedAt: null,
});
const companyRegulation = {
  id: "reg-company",
  title: "Buyer timber policy",
  officialId: null,
  shared: false,
  versionCount: 1,
  createdAt: "2026-10-14T08:00:00Z",
};
const companyDocument = {
  id: "doc-c1",
  title: "Buyer timber policy 2026",
  filename: "policy.pdf",
  contentType: "application/pdf",
  sizeBytes: 2048,
  checksum: "abc",
  sourceUrl: null,
  regulationId: "reg-company",
  versionNumber: 1,
  createdAt: "2026-10-14T08:00:00Z",
};
function solution(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    market: "EU",
    requirementKey: "eudr-geolocation",
    problemStatus: "missing",
    summary: "Get the harvest plot geolocation from Server Supplier.",
    steps: [
      "Server Supplier: send the geolocation of every plot.",
      "You: check the plots match SERVER-1 before shipping.",
    ],
    status: "suggested",
    writtenFor: "SERVER-1",
    basis: {
      regulationTitle: "EU Deforestation Regulation",
      documentId: "doc-1",
      versionNumber: 2,
      sourceUrl: null,
      quote: "Article 9(1)(d): the geolocation of all plots of land",
    },
    validUntil: "2027-01-12",
    expired: false,
    expiredReason: null,
    model: "gemini-2.5-flash",
    createdBy: { id: "user-1", name: "Test Owner" },
    createdAt: "2026-10-15T09:00:00Z",
    reviewedBy: null,
    reviewedAt: null,
    supersedesId: null,
    usedFor: 0,
    notes: [],
    ...extra,
  };
}
async function fixture(
  page: Page,
  options: {
    failOrders?: boolean;
    viewer?: boolean;
    onboarding?: boolean;
    twoOrders?: boolean; // IMPORTED-1 is listed without an import first
  } = {},
) {
  const requests: {
    path: string;
    query: string;
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
  const report: any = analysisReport();
  const messages: any[] = [];
  const solutions: any[] = [
    solution("sol-old", {
      summary: "Ask for a map of the plots.",
      expired: true,
      expiredReason: "It was valid until 2026-09-30.",
      status: "adopted",
      notes: [
        {
          id: "note-1",
          author: { id: "user-2", name: "Customs Broker" },
          text: "We ask for GeoJSON, not a screenshot.",
          createdAt: "2026-07-01T09:00:00Z",
        },
      ],
    }),
  ];
  let solutionInUse = false;
  const solutionCase = () => {
    const valid = solutions.filter((s) => !s.expired && s.status !== "rejected");
    return {
      requirementKey: "eudr-geolocation",
      title: "Plot-level geolocation",
      problemStatus: "missing",
      note: "Server Supplier has no plot geolocation on file.",
      default: valid[0] ?? null,
      inUse: solutionInUse && !!valid[0],
      others: [],
      expired: solutions.filter((s) => s.expired),
      needsAnalysis: !valid[0],
    };
  };
  let suggestions: any[] = [];
  let noCodeOrder: any = { ...noCode, status: "needs_data" };
  let noCodeReport: string | null = null;
  let settings = [
    costSetting("delay_per_day", "Delay, per day", "USD", 35000),
    costSetting("supplier_lead_days", "Supplier lead time", "days", 14),
  ];
  let requirements: any[] = [];
  let serverStatus = order.status;
  let uploadedStatus = uploaded.status;
  const statusChanges: any[] = [];
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
      query: url.search,
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
        ? committed || options.twoOrders
          ? [{ ...uploaded, status: uploadedStatus }]
          : []
        : [{ ...order, status: serverStatus }];
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
    else if (path === "/order-statuses") data = orderStatuses;
    else if (path === "/orders/status" && method === "PATCH") {
      const statuses: Record<string, string> = {
        "SERVER-1": serverStatus,
        "IMPORTED-1": uploadedStatus,
      };
      const ids: string[] = body.orderIds;
      const changed = ids.filter((id) => statuses[id] !== body.status);
      if (!changed.length) {
        const label = orderStatuses.find((o) => o.code === body.status)?.label;
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: "status_unchanged",
              message: `These orders are already “${label}”.`,
            },
          },
        });
        return;
      }
      if (changed.includes("SERVER-1")) serverStatus = body.status;
      if (changed.includes("IMPORTED-1")) uploadedStatus = body.status;
      data = {
        changed: changed.map((id) => ({
          ...(id === "SERVER-1" ? order : uploaded),
          status: body.status,
        })),
        unchanged: ids.filter((id) => !changed.includes(id)),
      };
    }
    else if (path === "/orders/SERVER-1/status" && method === "PATCH") {
      if (!String(body.note || "").trim()) {
        await route.fulfill({
          status: 422,
          json: { error: { code: "validation_error", message: "Add a note." } },
        });
        return;
      }
      statusChanges.unshift({
        id: `change-${statusChanges.length + 1}`,
        fromStatus: serverStatus,
        toStatus: body.status,
        source: "manual",
        note: body.note,
        runId: null,
        changedBy: { id: "user-1", name: "Test Owner" },
        changedAt: "2026-10-15T10:00:00Z",
      });
      serverStatus = body.status;
      data = {
        order: { ...order, status: serverStatus },
        source: null,
        exposures: [],
        latestReportId: "report-1",
        statusChanges,
      };
    } else if (path === "/orders/SERVER-1")
      data = {
        order: { ...order, status: serverStatus },
        statusChanges,
        source: {
          importId: "import-1",
          rowNumber: 2,
          raw: { hsCode: "0401.10", value: "1234.56" },
          rowHash: "hash",
        },
        exposures: [],
        latestReportId: "report-1",
      };
    else if (path === "/orders/NOCODE-1")
      data = {
        order: noCodeOrder,
        source: null,
        exposures: [],
        latestReportId: noCodeReport,
      };
    else if (path === "/runs" && method === "POST")
      data = runOf([
        {
          id: "report-1",
          orderId: "SERVER-1",
          state: "needs_human_review",
          orderStatus: "exposed",
          blocked: false,
          costTotals: { EUR: 119994 },
          missingData: [],
        },
      ]);
    else if (path === "/reports/report-1") data = report;
    else if (path === "/reports/report-2")
      data = {
        ...analysisReport(),
        id: "report-2",
        order: noCodeOrder,
        state: "pass",
        orderStatus: "clear",
        findings: [],
        costLines: [],
        costTotals: {},
        unpricedCosts: [],
        rulesFired: [],
        suggestedAction: { kind: "none", text: "Nothing to do for NOCODE-1.", requestBy: null },
        messageBlockedReason: "Nothing is missing, so there is nothing to ask the supplier.",
      };
    else if (path === "/reports/report-1/review") {
      report.review = {
        reviewedBy: { id: "user-1", name: "Test Owner" },
        reviewedAt: "2026-10-15T09:00:00Z",
        note: body.note,
      };
      report.messageBlockedReason = null;
      data = report;
    } else if (path === "/reports/report-1/feedback")
      data = { useful: body.useful ? 1 : 0, notUseful: body.useful ? 0 : 1, mine: body.useful, myNote: body.note };
    else if (path === "/orders/SERVER-1/supplier-messages") data = messages;
    else if (path === "/supplier-messages" && method === "POST") {
      const message = {
        id: "msg-1",
        reportId: body.reportId,
        orderId: "SERVER-1",
        supplierId: "supplier-1",
        status: "draft",
        recipient: "sales@server-supplier.example",
        subject: "SERVER-1: plot geolocation",
        body: "Hello,\nPlease send the plot geolocation for SERVER-1.",
        createdBy: { id: "user-1", name: "Test Owner" },
        createdAt: "2026-10-15T09:01:00Z",
        approvedBy: null,
        approvedAt: null,
        approvedByAuthor: false,
        sentAt: null,
        sandbox: null,
        error: null,
      };
      messages.unshift(message);
      await route.fulfill({ status: 201, json: { data: message, meta } });
      return;
    } else if (path === "/supplier-messages/msg-1") {
      const { saveRecipientToSupplier: _, ...changes } = body;
      Object.assign(messages[0], changes, { status: "draft" });
      data = messages[0];
    } else if (path === "/supplier-messages/msg-1/approve") {
      Object.assign(messages[0], {
        status: "approved",
        approvedBy: { id: "user-1", name: "Test Owner" },
        approvedAt: "2026-10-15T09:02:00Z",
        approvedByAuthor: true,
      });
      data = messages[0];
    } else if (path === "/supplier-messages/msg-1/send") {
      Object.assign(messages[0], {
        status: "sent",
        sentAt: "2026-10-15T09:03:00Z",
        sandbox: true,
      });
      data = messages[0];
    } else if (path === "/reports/report-1/solutions") {
      if (method === "POST") {
        solutions.unshift(solution("sol-new", { supersedesId: "sol-old" }));
        await route.fulfill({ status: 201, json: { data: solutionCase(), meta } });
        return;
      }
      data = [solutionCase()];
    } else if (path === "/reports/report-2/solutions") data = [];
    else if (path === "/solutions")
      data = [
        {
          market: "EU",
          requirementKey: "eudr-geolocation",
          problemStatus: "missing",
          title: "Plot-level geolocation",
          inChecklist: true,
          solutions: [...solutions].sort((x, y) => +x.expired - +y.expired),
        },
      ];
    else if (path === "/solutions/sol-new/use") {
      solutionInUse = true;
      solutions[0].usedFor = 1;
      data = solutionCase();
    } else if (path === "/solutions/sol-new/notes") {
      solutions[0].notes.push({
        id: "note-2",
        author: { id: "user-1", name: "Test Owner" },
        text: body.text,
        createdAt: "2026-10-15T09:05:00Z",
      });
      data = solutions[0];
    } else if (path === "/solutions/sol-new/review") {
      Object.assign(solutions[0], {
        status: body.verdict,
        reviewedBy: { id: "user-1", name: "Test Owner" },
        reviewedAt: "2026-10-15T09:06:00Z",
      });
      data = solutions[0];
    } else if (path === "/orders/NOCODE-1/hs-suggestions") {
      if (method === "POST") {
        suggestions = [suggestion("hs-1", "9403.60"), suggestion("hs-2", "9401.61")];
        await route.fulfill({ status: 201, json: { data: suggestions, meta } });
        return;
      }
      data = suggestions;
    } else if (path === "/hs-suggestions/hs-2/reject") {
      suggestions[1] = { ...suggestions[1], status: "rejected" };
      data = suggestions[1];
    } else if (path === "/hs-suggestions/hs-1/accept") {
      suggestions[0] = { ...suggestions[0], status: "accepted" };
      noCodeOrder = { ...noCodeOrder, hsCode: "9403.60", status: "clear" };
      noCodeReport = "report-2";
      data = {
        suggestion: suggestions[0],
        order: noCodeOrder,
        run: runOf([
          {
            id: "report-2",
            orderId: "NOCODE-1",
            state: "pass",
            orderStatus: "clear",
            blocked: false,
            costTotals: {},
            missingData: [],
          },
        ]),
      };
    } else if (path === "/playbook/fields") data = ruleFields;
    else if (path === "/company/members")
      data = [
        {
          userId: "user-1",
          name: "Test Owner",
          email: "owner@example.com",
          role: me.role,
          joinedAt: "2026-10-01T09:00:00Z",
          you: true,
        },
      ];
    else if (path === "/company/invites" || path === "/me/invites") data = [];
    else if (path === "/company/cost-settings") {
      if (method === "PATCH")
        settings = settings.map((s) => {
          const change = body.settings.find((c: any) => c.key === s.key);
          if (!change) return s;
          return change.value === null
            ? { ...s, value: s.defaultValue, unit: s.defaultUnit, source: "default" }
            : { ...s, value: change.value, unit: change.unit ?? s.unit, source: "company_setting" };
        });
      data = settings;
    } else if (path === "/audit-events") {
      data = [
        {
          id: "ev-1",
          action: "supplier_message.sent",
          objectType: "supplier_message",
          objectId: "msg-1",
          data: { sandbox: true },
          user: { id: "user-1", name: "Test Owner", email: "owner@example.com" },
          requestId: "req-1",
          createdAt: "2026-10-15T09:03:00Z",
        },
      ];
      meta = { nextCursor: "page-2" };
    } else if (path === "/audit-events/export") {
      await route.fulfill({
        contentType: "text/csv; charset=utf-8",
        headers: {
          "Content-Disposition": 'attachment; filename="exportmate-activity-2026-10-15.csv"',
        },
        body: "time_utc,person,email,action\n2026-10-15 09:03:00,Test Owner,owner@example.com,supplier_message.sent\n",
      });
      return;
    } else if (path === "/regulations") data = [{ ...companyRegulation, latestVersion: companyDocument }];
    else if (path === "/regulations/reg-company")
      data = { ...companyRegulation, latestVersion: companyDocument, versions: [companyDocument] };
    else if (path === "/regulations/reg-company/requirements") {
      const decided = requirements.length > 0 && requirements.every((r) => r.status !== "draft");
      data = {
        regulationId: "reg-company",
        documentId: "doc-c1",
        versionNumber: 1,
        previousVersionNumber: null,
        inForce: decided && requirements.some((r) => r.status === "reviewed"),
        requirements,
        changes: [],
      };
    } else if (path === "/regulation-documents/doc-c1/requirements") {
      requirements = [
        requirement("req-1", "Legality evidence", true),
        requirement("req-2", "Species list", false),
      ];
      data = {
        regulationId: "reg-company",
        documentId: "doc-c1",
        versionNumber: 1,
        previousVersionNumber: null,
        inForce: false,
        requirements,
        changes: [],
        readAs: "text",
        sectionsSelected: false,
        dropped: { quote_not_in_document: 1 },
      };
    } else if (path.startsWith("/market-requirements/")) {
      const id = path.split("/").pop();
      requirements = requirements.map((r) =>
        r.id === id
          ? { ...r, ...body, quoteVerified: body.sourceQuote ? true : r.quoteVerified }
          : r,
      );
      data = requirements.find((r) => r.id === id);
    } else if (path === "/contact") {
      await route.fulfill({ status: 202, json: { data: { received: true }, meta } });
      return;
    }
    else if (path === "/report-drafts" && method === "POST") {
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
    } else if (path === "/report-drafts") data = [...reports.values()];
    else if (/^\/report-drafts\/r-\d+\/pdf$/.test(path)) {
      await route.fulfill({
        contentType: "application/pdf",
        headers: {
          "Content-Disposition": 'inline; filename="exportmate-SERVER-1-API-plywood.pdf"',
        },
        body: "%PDF-1.4 test report",
      });
      return;
    } else if (/^\/report-drafts\/r-\d+\/email$/.test(path)) {
      const draft = reports.get(path.split("/")[2]);
      draft.sentAt = "2026-10-15T09:00:00Z";
      draft.sentTo = body.to;
      data = { recipients: body.to, sandbox: true, sentAt: draft.sentAt };
    } else if (/^\/report-drafts\/r-\d+$/.test(path)) {
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
        const rule = { ...body, id: "rule-2", checked: !!body.when };
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
          rule.id === id
            ? { ...rule, ...body, ...("when" in body ? { checked: !!body.when } : {}) }
            : rule,
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
      data = {
        ordersCreated: 1,
        run: runOf([
          {
            id: "report-3",
            orderId: "IMPORTED-1",
            state: "pass",
            orderStatus: "exposed",
            blocked: false,
            costTotals: {},
            missingData: ["Add Test to the suppliers, with their documents."],
          },
        ]),
      };
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
  await expect(
    page.getByRole("button", { name: "Needs data", exact: true }),
  ).toHaveCount(0);
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
  await page.route("**/api/v1/trade-map/changes", (route) =>
    route.fulfill({
      json: {
        data: {
          start: "2026-10-15",
          until: "2027-02-12",
          days: 120,
          changes: [
            {
              on: "2026-12-30",
              kind: "effective",
              market: "EU",
              marketName: "European Union",
              requirementKey: "dds",
              title: "Due-diligence statement reference",
              whatChanges: "Takes effect. Large operators file a statement per shipment.",
              orderIds: ["SERVER-1"],
              source: {
                regulationId: "reg-2",
                regulationTitle: "Timber due diligence",
                officialId: null,
                documentId: "doc-2",
                documentTitle: "Guidance",
                versionNumber: 2,
                sourceUrl: null,
                quote: "Operators shall file…",
              },
            },
          ],
        },
      },
    }),
  );
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/rules");
  // One sidebar item for news, rules, regulations and the playbook; a tab per page.
  await expect(page.locator(".nav-item.active")).toHaveText("Rules & news");
  const tabs = page.getByRole("navigation", { name: "Rules & news" });
  await expect(tabs.getByRole("link", { name: "Rule watch" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("heading", { name: "Coming up." })).toBeVisible();
  // The window is the one the backend reports, not a frontend constant.
  await expect(page.getByText("NEXT 120 DAYS")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Due-diligence statement reference" }),
  ).toBeVisible();
  await expect(page.getByText("1 open order affected")).toBeVisible();
  await expect(page.getByText("Takes effect on 30 Dec 2026 · European Union")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Timber due diligence, version 2/ }),
  ).toHaveAttribute("href", "#/workspace/regulations/documents/doc-2");
  await expect(page.getByRole("button", { name: "SERVER-1", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Plot-level geolocation" })).toBeVisible();
  await expect(page.getByText("1 of 1 orders have a gap")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /EU Deforestation Regulation/ }),
  ).toHaveAttribute("href", "#/workspace/regulations/documents/doc-1");
  await expect(page.getByText("Geolocation documentation for EU-bound wood")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run rule-change demo" })).toHaveCount(0);
  await tabs.getByRole("link", { name: "Playbook" }).click();
  await expect(page).toHaveURL(/#\/workspace\/playbook$/);
  await expect(page.locator(".nav-item.active")).toHaveText("Rules & news");
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
  expect(requests.find((r) => r.path === "/report-drafts")?.body).toEqual({
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
  const saved = requests.find((r) => r.method === "PATCH" && r.path === "/report-drafts/r-1");
  expect(saved?.body.content.title).toBe("SERVER-1 for our buyer");
  const rows = saved?.body.content.sections[1].rows;
  expect(rows[0].cells[2]).toBe("Requested from supplier on 14 Oct.");
  expect(rows[1].included).toBe(false);
  expect(rows[2]).toMatchObject({ cells: ["Buyer audit", "", "", ""], included: true });
  expect(requests.some((r) => r.path === "/report-drafts/r-1/pdf")).toBeTruthy();

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
  const [sent] = requests.filter((r) => r.path === "/report-drafts/r-1/email");
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
  expect(requests.find((r) => r.path === "/report-drafts" && r.method === "POST")?.body).toEqual({
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
  // The import analysed the order, and the Orders page says what it still needs.
  await expect(page.getByText(/1 order imported and analysed\./)).toBeVisible();
  await expect(
    page.getByText("Add Test to the suppliers, with their documents."),
  ).toBeVisible();
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
  await page.goto("/#/workspace/orders");
  await expect(page.getByRole("button", { name: "SERVER-1", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
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

test("a company user sees what the assistant remembers and can make it forget", async ({ page }) => {
  await fixture(page);
  let memories = [
    { id: "101", fact: "I mainly sell plywood to the UK.", updatedAt: "2026-10-14T20:50:00Z" },
    { id: "102", fact: "Keep answers to short bullet points.", updatedAt: "2026-10-14T20:50:00Z" },
  ];
  const calls: { method: string; path: string; auth?: string }[] = [];
  await page.route("**/api/memories**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push({ method: request.method(), path, auth: request.headers().authorization });
    if (request.method() === "DELETE") {
      memories = memories.filter((m) => !path.endsWith(`/${m.id}`));
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { memories, enabled: true, keepDays: 180 } });
  });
  await login(page);
  await page.goto("/#/workspace/account");
  const panel = page.getByRole("region", { name: "What the assistant remembers" });
  await expect(panel.getByText("I mainly sell plywood to the UK.")).toBeVisible();
  await expect(panel).toContainText("what you work on, for 180 days, so it doesn't have to ask again");
  await panel.getByRole("button", { name: "Forget: Keep answers to short bullet points." }).click();
  await expect(panel.getByText("Forgotten.")).toBeVisible();
  await expect(panel.getByText("Keep answers to short bullet points.")).toHaveCount(0);
  expect(calls.find((c) => c.method === "DELETE")?.path).toBe("/api/memories/102");
  expect(calls.every((c) => c.auth?.startsWith("Bearer "))).toBe(true);
});

test("an AI service without Memory Bank shows memory as switched off, not an error", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/memories**", (route) => route.fulfill({ status: 404, json: { error: "Not found" } }));
  await login(page);
  await page.goto("/#/workspace/account");
  const panel = page.getByRole("region", { name: "What the assistant remembers" });
  await expect(panel.getByText("Memory isn't switched on for this workspace yet.")).toBeVisible();
  await expect(panel).toContainText("what you work on, so it doesn't have to ask again");
  await expect(panel.getByText("Not found")).toHaveCount(0);
});

test("analyses every order from the Orders page and shows each step", async ({ page }) => {
  const requests = await fixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.getByRole("button", { name: "Analyse orders" }).first().click();
  await expect(page).toHaveURL(/#\/workspace\/orders$/);
  const panel = page.getByRole("region", { name: "Analysis" });
  await panel.getByRole("button", { name: "Analyse orders" }).click();
  await expect(panel.getByText("auditor done")).toBeVisible();
  await expect(panel.getByRole("link", { name: "SERVER-1" })).toHaveAttribute(
    "href",
    "#/workspace/orders/SERVER-1",
  );
  await expect(panel.getByText("Waiting for the owner's review")).toBeVisible();
  await expect(panel.getByText("€1,199.94")).toBeVisible();
  const runs = requests.filter((r) => r.path === "/runs");
  expect(runs).toHaveLength(1);
  expect(runs[0].body).toEqual({});
  // Orders and the overview are read again, without reloading the page.
  expect(requests.filter((r) => r.path === "/overview").length).toBeGreaterThan(1);
});

test("the order's report: owner review, feedback, and a supplier email approved and sent once", async ({
  page,
}) => {
  const requests = await fixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/orders/SERVER-1");
  const report = page.getByRole("region", { name: "Analysis report" });
  await expect(
    report.getByRole("heading", { name: "Ask Server Supplier for the plot geolocation." }),
  ).toBeVisible();
  await expect(report.getByText("Ask the supplier by 10 Dec 2026")).toBeVisible();
  await expect(report.getByText("Plot-level geolocation")).toBeVisible();
  // The row shows the amount; hovering it shows the sum and the setting it came from.
  await expect(report.getByText("14 days × EUR 85.71")).toHaveCount(0);
  await report.getByText("€1,199.94", { exact: true }).first().hover();
  const why = page.getByRole("tooltip");
  await expect(why).toContainText("14 days × EUR 85.71 = €1,199.94");
  await expect(why).toContainText("Your cost setting: Your delay cost per day.");
  await expect(report.getByText("Not priced")).toBeVisible();
  await expect(report.getByText("Server policy")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Original CSV row" })).toBeVisible();

  const messages = page.getByRole("region", { name: "Supplier messages" });
  await expect(messages.getByRole("button", { name: "Draft email to supplier" })).toBeDisabled();
  const review = report.getByRole("group", { name: "Owner review" });
  await review.getByLabel("Note (optional)").fill("Buyer agreed.");
  await review.getByRole("button", { name: "Reviewed: OK to contact the supplier" }).click();
  await expect(report.getByText(/Reviewed by Test Owner .*: “Buyer agreed.”/)).toBeVisible();
  expect(requests.find((r) => r.path === "/reports/report-1/review")?.body).toEqual({
    note: "Buyer agreed.",
  });

  await report.getByRole("button", { name: "Useful", exact: true }).click();
  await report.getByLabel("Feedback note (optional)").fill("Clear next step.");
  await report.getByRole("button", { name: "Send feedback" }).click();
  await expect(report.getByRole("button", { name: "Useful", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(requests.find((r) => r.path === "/reports/report-1/feedback")?.body).toEqual({
    useful: true,
    note: "Clear next step.",
  });

  await messages.getByRole("button", { name: "Draft email to supplier" }).click();
  await expect(messages.getByLabel("To")).toHaveValue("sales@server-supplier.example");
  expect(requests.find((r) => r.path === "/supplier-messages")?.body).toEqual({
    reportId: "report-1",
  });
  // Unsaved edits must be saved before approving.
  await messages.getByLabel("Subject").fill("SERVER-1: geolocation, please");
  await expect(messages.getByRole("button", { name: "Approve" })).toBeDisabled();
  await messages.getByRole("button", { name: "Save changes" }).click();
  await expect(messages.getByRole("button", { name: "Approve" })).toBeEnabled();
  expect(
    requests.find((r) => r.path === "/supplier-messages/msg-1" && r.method === "PATCH")?.body,
  ).toEqual({
    recipient: "sales@server-supplier.example",
    subject: "SERVER-1: geolocation, please",
    body: "Hello,\nPlease send the plot geolocation for SERVER-1.",
    saveRecipientToSupplier: false,
  });
  await messages.getByRole("button", { name: "Approve" }).click();
  await messages.getByRole("button", { name: "Send" }).dblclick();
  await expect(
    page.getByText(
      "Sandbox: the message to sales@server-supplier.example was recorded but not delivered.",
    ),
  ).toBeVisible();
  await expect(messages.getByText("Sent · sandbox")).toBeVisible();
  await expect(messages.getByLabel("Subject")).toBeDisabled();
  const sends = requests.filter((r) => r.path === "/supplier-messages/msg-1/send");
  expect(sends).toHaveLength(1);
  expect(sends[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
});

test("an order without an HS code gets suggestions; accepting one analyses it again", async ({
  page,
}) => {
  const requests = await fixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/orders/NOCODE-1");
  const panel = page.getByRole("region", { name: "HS code suggestions" });
  await expect(panel.getByRole("heading", { name: "This order has no HS code." })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Analysis report" }).getByText("Not analysed yet."),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Suggest HS code" }).click();
  await expect(panel.getByText("Official wording of 9403.60")).toBeVisible();
  await expect(panel.getByText(/PO-1 \(Oak chair, 9401.61\); tariff line 9403.60/)).toBeVisible();
  await panel.locator(".an-hs-card").nth(1).getByRole("button", { name: "Reject" }).click();
  await expect(panel.getByText("Earlier suggestions: 9401.61 (rejected)")).toBeVisible();
  await panel.getByRole("button", { name: "Accept 9403.60" }).click();
  await expect(
    page.getByText("NOCODE-1 now has HS code 9403.60 and was analysed again."),
  ).toBeVisible();
  // The page reloads the order: it has a code now, and its new report shows.
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Nothing to do for NOCODE-1." })).toBeVisible();
  expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(
    expect.arrayContaining([
      "POST /orders/NOCODE-1/hs-suggestions",
      "POST /hs-suggestions/hs-2/reject",
      "POST /hs-suggestions/hs-1/accept",
      "GET /reports/report-2",
    ]),
  );
});

test("playbook rules get WHEN/THEN conditions that analysis checks", async ({ page }) => {
  const requests = await fixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/playbook");
  await expect(page.getByText(/order statuses don't use them yet/)).toHaveCount(0);
  await expect(page.getByText("NOT CHECKED")).toBeVisible();

  await page.getByLabel("In your own words").fill("Owner reviews late EU orders");
  const form = page.locator("form.add-rule");
  await form.getByLabel("Add conditions, so analysis applies this rule to orders").check();
  await expect(form.getByLabel("Condition 1: value")).toHaveValue("EU");
  await form.getByRole("button", { name: "And another condition" }).click();
  await form.getByLabel("Condition 2: field").selectOption("days_until_ship");
  await form.getByLabel("Condition 2: comparison").selectOption("less_than");
  await form.getByLabel("Condition 2: value").fill("21");
  await form.getByRole("button", { name: "And another condition" }).click();
  await form.getByLabel("Condition 3: field").selectOption("estimated_cost");
  await form.getByLabel("Condition 3: comparison").selectOption("greater_than");
  await form.getByLabel("Condition 3: amount").fill("2,000.50");
  await form.getByLabel("Then").selectOption("owner_review");
  await form.getByLabel("Note on the report (optional)").fill("Call the buyer");
  await page.getByRole("button", { name: "Add to my playbook" }).click();
  await expect(page.getByText("Rule saved. Analysis checks it on every order.")).toBeVisible();
  expect(
    requests.find((r) => r.path === "/playbook/rules" && r.method === "POST")?.body,
  ).toEqual({
    text: "Owner reviews late EU orders",
    category: "Policy",
    enabled: true,
    when: [
      { field: "market", op: "equals", value: "EU" },
      { field: "days_until_ship", op: "less_than", value: 21 },
      {
        field: "estimated_cost",
        op: "greater_than",
        value: { amountMinor: 200050, currency: "USD" },
      },
    ],
    then: { action: "owner_review", note: "Call the buyer" },
  });
  await expect(
    page.getByText(
      "When Market is European Union and Days until ship date less than 21 and Estimated cost of the problems (without duties) more than USD 2,000.50 → Send the report to the owner (needs human review) (“Call the buyer”)",
    ),
  ).toBeVisible();

  // A stored rule gets conditions in place.
  const stored = page.locator(".playbook-rule").first();
  await stored.getByRole("button", { name: "Add conditions" }).click();
  await stored.getByLabel("Add conditions, so analysis applies this rule to orders").check();
  await stored.getByRole("button", { name: "Save conditions" }).click();
  await expect(stored.getByText("CHECKED", { exact: true })).toBeVisible();
  expect(
    requests.find((r) => r.path === "/playbook/rules/rule-1" && r.method === "PATCH")?.body,
  ).toEqual({
    when: [{ field: "market", op: "equals", value: "EU" }],
    then: { action: "flag", note: null },
  });
});

test("owners change cost settings and read the activity log", async ({ page }) => {
  const requests = await fixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/account");
  const costs = page.getByRole("region", { name: "Cost settings" });
  await expect(costs.getByText("$350")).toBeVisible();
  await costs.getByLabel("Delay, per day: your value").fill("420.5");
  await costs.getByLabel("Delay, per day: currency").fill("EUR");
  await costs.getByLabel("Supplier lead time: your value").fill("10");
  await costs.getByRole("button", { name: "Save cost settings" }).click();
  await expect(page.getByText("Cost settings saved.")).toBeVisible();
  expect(
    requests.find((r) => r.path === "/company/cost-settings" && r.method === "PATCH")?.body,
  ).toEqual({
    settings: [
      { key: "delay_per_day", value: 42050, unit: "EUR" },
      { key: "supplier_lead_days", value: 10 },
    ],
  });
  await costs.getByRole("button", { name: "Reset to default" }).first().click();
  await expect(page.getByText("Delay, per day is back to the default.")).toBeVisible();
  expect(
    requests.filter((r) => r.path === "/company/cost-settings" && r.method === "PATCH")[1].body,
  ).toEqual({ settings: [{ key: "delay_per_day", value: null }] });

  const log = page.getByRole("region", { name: "Activity log" });
  await expect(log.getByText("supplier_message.sent")).toBeVisible();
  await expect(log.getByText("Older events are in the CSV download.")).toBeVisible();
  await expect(log.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(
    requests.filter((r) => r.path === "/audit-events").map((r) => r.query),
  ).toEqual(["?limit=10"]);
  await log.getByLabel("Show").selectOption("supplier_message");
  await log.getByLabel("Person").selectOption("user-1");
  await expect
    .poll(() => requests.filter((r) => r.path === "/audit-events").at(-1)?.query)
    .toBe("?limit=10&objectType=supplier_message&userId=user-1");
  const downloaded = page.waitForEvent("download");
  await log.getByRole("button", { name: "Download CSV" }).click();
  expect((await downloaded).suggestedFilename()).toBe("exportmate-activity-2026-10-15.csv");
  expect(requests.filter((r) => r.path === "/audit-events/export").at(-1)?.query).toBe(
    "?objectType=supplier_message&userId=user-1",
  );
});

test("editors draft a regulation's requirements; the owner edits, approves and rejects them", async ({
  page,
}) => {
  const requests = await fixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/regulations/reg-company");
  const panel = page.getByRole("region", { name: "Market requirements" });
  await expect(panel.getByText("No requirements drafted for this version yet.")).toBeVisible();
  await expect(panel.getByText("NOT IN FORCE")).toBeVisible();
  await panel.getByRole("button", { name: "Draft requirements" }).click();
  await expect(panel.getByText("Dropped 1 for the quote wasn't in the document.")).toBeVisible();
  await expect(panel.getByText("This quote wasn't found in the document's text.")).toHaveCount(1);
  const [legality, species] = [
    panel.locator(".reg-req").nth(0),
    panel.locator(".reg-req").nth(1),
  ];
  await species.getByRole("button", { name: "Edit" }).click();
  await species.getByLabel("Quote from the text").fill("Species must be listed.");
  await species.getByLabel("HS code prefixes (comma-separated)").fill("9403, 9401");
  await species.getByRole("button", { name: "Save draft" }).click();
  await expect(panel.getByText("This quote wasn't found in the document's text.")).toHaveCount(0);
  await species.getByRole("button", { name: "Reject" }).click();
  await legality.getByRole("button", { name: "Approve" }).click();
  await expect(panel.getByText("IN FORCE", { exact: true })).toBeVisible();
  const patches = requests.filter((r) => r.path.startsWith("/market-requirements/"));
  expect(patches.map((r) => [r.path, r.body.status])).toEqual([
    ["/market-requirements/req-2", undefined],
    ["/market-requirements/req-2", "rejected"],
    ["/market-requirements/req-1", "reviewed"],
  ]);
  expect(patches[0].body).toMatchObject({
    sourceQuote: "Species must be listed.",
    hsPrefixes: ["9403", "9401"],
    level: "supplier",
    documentKind: "legality",
  });
});

test("the landing page's contact form sends the message to the backend", async ({ page }) => {
  const requests = await fixture(page);
  await page.goto("/#/");
  const form = page.locator("#contact form");
  await form.getByLabel("Name").fill("Lan Nguyen");
  await form.getByLabel("Work email").fill("lan@example.com");
  await form.getByLabel("Company (optional)").fill("Binh Phu Wood");
  await form.getByLabel("What are you working on?").fill("EU furniture orders.");
  await form.getByRole("button", { name: "Send message" }).click();
  await expect(form.getByText("Received. We'll reply to your email.")).toBeVisible();
  const [sent] = requests.filter((r) => r.path === "/contact");
  expect(sent.body).toEqual({
    name: "Lan Nguyen",
    email: "lan@example.com",
    company: "Binh Phu Wood",
    message: "EU furniture orders.",
    website: "",
  });
  expect(sent.auth).toBeUndefined();
});

test("owners change an order's status with a note; the labels come from the backend", async ({
  page,
}) => {
  const requests = await fixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/orders/SERVER-1");
  const panel = page.getByRole("region", { name: "Status" });
  await expect(panel.getByText("No longer used.")).toBeVisible();
  await expect(panel.getByText("No status changes recorded yet.")).toBeVisible();
  const select = panel.getByLabel("Change the status to");
  // The current status, and one the backend doesn't allow by hand, aren't offered.
  await expect(select.locator("option")).toHaveText([
    "Choose a status…",
    "Awaiting analysis",
    "Cleared to ship",
    "Action needed",
  ]);
  await select.selectOption({ label: "Cleared to ship" });
  const save = panel.getByRole("button", { name: "Change status" });
  await expect(save).toBeDisabled();
  await panel.getByLabel("Note: why (required)").fill("   ");
  await expect(save).toBeDisabled();
  await panel
    .getByLabel("Note: why (required)")
    .fill("Buyer confirmed the plot geolocation by email.");
  await save.click();
  await expect(page.getByText("SERVER-1 is now “Cleared to ship”.")).toBeVisible();
  const patch = requests.find((r) => r.method === "PATCH" && r.path === "/orders/SERVER-1/status");
  expect(patch?.body).toEqual({
    status: "clear",
    note: "Buyer confirmed the plot geolocation by email.",
  });
  expect(patch?.auth).toBe("Bearer dev:owner@example.com");
  const history = panel.getByRole("listitem");
  await expect(history).toHaveCount(1);
  await expect(history).toContainText("Needs data → Cleared to ship");
  await expect(history).toContainText("Changed by Test Owner");
  await expect(history).toContainText("Buyer confirmed the plot geolocation by email.");
  await expect(panel.getByText("Every document is on file.")).toBeVisible();
  await expect(panel.getByLabel("Change the status to").locator("option")).not.toContainText([
    "Cleared to ship",
  ]);

  await page.goto("/#/workspace/orders");
  await page.getByRole("button", { name: "Cleared to ship", exact: true }).click();
  await expect(
    page.getByRole("table").getByText("Cleared to ship", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "SERVER-1", exact: true })).toBeVisible();
});

test("owners tick several orders and change their status with one note", async ({ page }) => {
  const requests = await fixture(page, { twoOrders: true });
  await login(page);
  await page.goto("/#/workspace/orders");
  const table = page.getByRole("table");
  await expect(table.getByRole("button", { name: "IMPORTED-1", exact: true })).toBeVisible();
  const bar = page.getByRole("form", { name: "Change the status of the selected orders" });
  await expect(bar).toHaveCount(0);

  await page.getByLabel("Select every order shown").check();
  await expect(bar.getByText("2 orders selected")).toBeVisible();
  // Only the statuses the backend allows by hand.
  await expect(bar.getByLabel("Change the status to").locator("option")).toHaveText([
    "Choose a status…",
    "Awaiting analysis",
    "Cleared to ship",
    "Action needed",
  ]);
  await bar.getByLabel("Change the status to").selectOption({ label: "Cleared to ship" });
  const save = bar.getByRole("button", { name: "Change 2 orders" });
  await expect(save).toBeDisabled();
  await bar.getByLabel("Note: why (required)").fill("Buyer confirmed both by email.");
  await save.click();
  await expect(page.getByText("2 orders are now “Cleared to ship”.")).toBeVisible();
  const patch = requests.find((r) => r.method === "PATCH" && r.path === "/orders/status");
  expect(patch?.body.status).toBe("clear");
  expect(patch?.body.note).toBe("Buyer confirmed both by email.");
  expect([...patch?.body.orderIds].sort()).toEqual(["IMPORTED-1", "SERVER-1"]);
  expect(patch?.auth).toBe("Bearer dev:owner@example.com");
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await expect(table.getByText("Cleared to ship", { exact: true })).toHaveCount(2);

  // A ticked order the search hides isn't changed.
  await page.getByLabel("Select SERVER-1").check();
  await page.getByLabel("Search orders").fill("IMPORTED");
  await expect(bar).toHaveCount(0);
  await page.getByLabel("Search orders").fill("");
  await expect(bar.getByText("1 order selected")).toBeVisible();
  await bar.getByLabel("Change the status to").selectOption({ label: "Action needed" });
  await bar.getByLabel("Note: why (required)").fill("Plot geolocation is missing.");
  await bar.getByRole("button", { name: "Change 1 order" }).click();
  await expect(page.getByText("1 order is now “Action needed”.")).toBeVisible();
  expect(requests.filter((r) => r.path === "/orders/status").at(-1)?.body.orderIds).toEqual([
    "SERVER-1",
  ]);

  // SERVER-1 already has the status: the backend leaves it alone and says so.
  await page.getByLabel("Select every order shown").check();
  await bar.getByLabel("Change the status to").selectOption({ label: "Action needed" });
  await bar.getByLabel("Note: why (required)").fill("Still missing.");
  await bar.getByRole("button", { name: "Change 2 orders" }).click();
  await expect(page.getByText("1 order is now “Action needed”. 1 already was.")).toBeVisible();

  // Both already have it: the backend refuses and the selection stays for another try.
  await page.getByLabel("Select every order shown").check();
  await bar.getByLabel("Change the status to").selectOption({ label: "Action needed" });
  await bar.getByLabel("Note: why (required)").fill("Again.");
  await bar.getByRole("button", { name: "Change 2 orders" }).click();
  await expect(page.getByText("These orders are already “Action needed”.")).toBeVisible();
  await expect(bar.getByText("2 orders selected")).toBeVisible();
});

test("problems get AI solutions; expired ones are for reference and get analysed again", async ({
  page,
}) => {
  const requests = await fixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/orders/SERVER-1");
  const panel = page.getByRole("region", { name: "Suggested solutions" });
  const problem = panel.getByRole("article", { name: "Plot-level geolocation" });
  await expect(problem.getByText("The saved solutions for this problem expired.")).toBeVisible();
  // The expired one is listed, but never as the answer and never usable.
  await problem.getByText("Expired solutions (1), for reference only").click();
  await expect(
    problem.getByText("Not for use: It was valid until 2026-09-30."),
  ).toBeVisible();
  await expect(problem.getByText("We ask for GeoJSON, not a screenshot.")).toBeVisible();
  await expect(problem.getByRole("button", { name: "Use for SERVER-1" })).toHaveCount(0);

  await problem.getByRole("button", { name: "Analyse again" }).click();
  await expect(
    problem.getByText("Get the harvest plot geolocation from Server Supplier."),
  ).toBeVisible();
  expect(
    requests.find((r) => r.path === "/reports/report-1/solutions" && r.method === "POST")?.body,
  ).toEqual({ requirementKey: "eudr-geolocation" });

  await problem.getByRole("button", { name: "Use for SERVER-1" }).click();
  await expect(problem.getByText("Used for SERVER-1", { exact: true })).toBeVisible();
  expect(requests.find((r) => r.path === "/solutions/sol-new/use")?.body).toEqual({
    reportId: "report-1",
  });

  const card = problem.locator(".sol-card.default");
  await card.getByLabel(/Add how you handle it/).fill("Our broker files it through TRACES.");
  await card.getByRole("button", { name: "Add note" }).click();
  await expect(card.getByText("Our broker files it through TRACES.")).toBeVisible();
  expect(requests.find((r) => r.path === "/solutions/sol-new/notes")?.body).toEqual({
    text: "Our broker files it through TRACES.",
  });

  await card.getByRole("button", { name: "Adopt for this problem" }).click();
  await expect(card.getByText("Adopted", { exact: true })).toBeVisible();
  expect(requests.find((r) => r.path === "/solutions/sol-new/review")?.body).toEqual({
    verdict: "adopted",
    note: null,
  });
});

test("the knowledge base lists every saved solution by problem, with filters", async ({
  page,
}) => {
  const requests = await fixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/knowledge");
  await expect(page.getByRole("heading", { name: "Knowledge base." })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Rules & news" }).getByRole("link", {
      name: "Knowledge base",
    }),
  ).toHaveAttribute("aria-current", "page");
  // Only an expired solution is saved: the default "Valid" view has nothing to show.
  await expect(page.getByText("No valid solutions match.")).toBeVisible();
  await page.getByRole("tab", { name: "Expired" }).click();
  const problem = page.getByRole("region", { name: "EU: Plot-level geolocation" });
  await expect(problem.getByText("Ask for a map of the plots.")).toBeVisible();
  await expect(problem.getByText("Not for use: It was valid until 2026-09-30.")).toBeVisible();
  await expect(problem.getByText("We ask for GeoJSON, not a screenshot.")).toBeVisible();
  // No order here: a solution is used from the order's report, never from the library.
  await expect(problem.getByRole("button", { name: /Use for/ })).toHaveCount(0);
  await expect(problem.getByLabel(/Add how you handle it/)).toBeVisible();

  await page.getByLabel("Search solutions").fill("geojson");
  await expect(problem).toBeVisible();
  await page.getByLabel("Search solutions").fill("no such words");
  await expect(page.getByText("No expired solutions match.")).toBeVisible();
  expect(requests.filter((r) => r.path === "/solutions")).toHaveLength(1);
});

test("viewers read the analysis but can't start, review or message", async ({ page }) => {
  await fixture(page, { viewer: true });
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/orders");
  await expect(page.getByText("Owners and editors can start an analysis.")).toBeVisible();
  await page.goto("/#/workspace/orders/SERVER-1");
  const report = page.getByRole("region", { name: "Analysis report" });
  await expect(report.getByText("Plot-level geolocation")).toBeVisible();
  await expect(report.getByRole("button", { name: "Analyse again" })).toHaveCount(0);
  await expect(report.getByRole("button", { name: /Reviewed: OK/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Draft email to supplier" })).toHaveCount(0);
  const solutions = page.getByRole("region", { name: "Suggested solutions" });
  await expect(solutions.getByText("Plot-level geolocation")).toBeVisible();
  await expect(solutions.getByRole("button")).toHaveCount(0);
  await expect(solutions.getByLabel(/Add how you handle it/)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Status" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change status" })).toHaveCount(0);
  await page.goto("/#/workspace/account");
  await expect(
    page.getByRole("region", { name: "Cost settings" }).locator("span.mono").first(),
  ).toHaveText("$350.00");
  await expect(page.getByRole("button", { name: "Save cost settings" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Activity log" })).toHaveCount(0);
});

// Which orders a news alert affects is the company's call: the backend suggests, owners and
// editors confirm or reject with their own token, viewers only read.
async function newsReviewFixture(page: Page) {
  const reviews: { method: string; path: string; body: any; auth?: string }[] = [];
  await page.route("**/api/impacts**", (route) =>
    route.fulfill({
      json: {
        scan: null,
        impacts: [
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
            affected: [],
            stockValueUsd: 0,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    }),
  );
  let review: any = null;
  await page.route("**/api/v1/news-matches**", async (route) => {
    const request = route.request();
    const method = request.method();
    if (method !== "GET") {
      reviews.push({
        method,
        path: new URL(request.url()).pathname,
        body: method === "PUT" ? request.postDataJSON() : null,
        auth: request.headers().authorization,
      });
      review =
        method === "PUT"
          ? {
              ...request.postDataJSON(),
              reviewedBy: { id: "u1", name: "Lan" },
              reviewedAt: new Date().toISOString(),
            }
          : null;
      await route.fulfill({ json: { data: {}, meta: {} } });
      return;
    }
    await route.fulfill({
      json: {
        data: {
          newsAvailable: true,
          matches: [
            {
              impactId: "eudr",
              orderId: "PO-1",
              product: "Acacia plywood",
              destination: "Rotterdam, NL",
              market: "EU",
              shipDate: "2026-12-01",
              suggested: true,
              reason: "HS 4412 and ships to EU, like PLY-001 named in this alert.",
              review,
            },
          ],
        },
        meta: {},
      },
    });
  });
  return reviews;
}

test("owners confirm which orders a news alert affects with their token", async ({
  page,
}) => {
  await fixture(page);
  const reviews = await newsReviewFixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/news");
  await page.getByRole("button", { name: /Orders this may affect/ }).click();
  await page.getByRole("button", { name: "Add a note on PO-1" }).click();
  await page.getByLabel("PO-1 (optional)").fill("Rotterdam lot");
  await page.getByRole("button", { name: "PO-1: affects this order" }).click();
  await expect(page.locator(".news-orders li.confirmed")).toContainText("Lan");
  await page.getByRole("button", { name: "Undo the verdict on PO-1" }).click();
  await expect(page.getByText("1 to review")).toBeVisible();
  expect(reviews.map((r) => [r.method, r.path])).toEqual([
    ["PUT", "/api/v1/news-matches/eudr/orders/PO-1"],
    ["DELETE", "/api/v1/news-matches/eudr/orders/PO-1"],
  ]);
  expect(reviews[0].body).toEqual({ verdict: "relevant", note: "Rotterdam lot" });
  expect(reviews.every((r) => r.auth === "Bearer dev:owner@example.com")).toBeTruthy();
});

test("viewers see suggested orders awaiting review without the buttons", async ({
  page,
}) => {
  await fixture(page, { viewer: true });
  const reviews = await newsReviewFixture(page);
  await login(page);
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await page.goto("/#/workspace/news");
  await page.getByRole("button", { name: /Orders this may affect/ }).click();
  await expect(page.locator(".news-orders li")).toContainText("Awaiting review");
  await expect(page.getByRole("button", { name: /affects this order/ })).toHaveCount(0);
  await expect(page.getByLabel("Order to link")).toHaveCount(0);
  expect(reviews).toHaveLength(0);
});
