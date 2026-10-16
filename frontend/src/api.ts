import type { Polygon } from "geojson";
import { getToken } from "./auth";
import type { Order, Rule } from "./data";
import { defaultProfile, putProfile, type Profile } from "./account-store";

export type Account = {
  user: {
    id: string;
    email: string;
    name: string;
    alerts: boolean;
    digest: boolean;
  };
  company: {
    id: string;
    name: string;
    businessRole: string;
    origin: string;
    transit: string[];
    destination: string;
    currency: string;
    description: string;
    products: string;
    materials: string;
    certifications: string;
    website: string | null;
    foundedYear: number | null;
    teamSize: string | null;
    updatedAt: string;
  } | null;
  role: "owner" | "editor" | "viewer" | null;
  onboarded: boolean;
};
export type ApiOrder = Omit<Order, "value" | "risk"> & {
  valueMinor: number;
  currency: string;
  status: "awaiting_analysis" | "clear" | "exposed" | "needs_data";
};
// Order statuses as the backend's database names them (GET /order-statuses).
export type OrderStatusOption = {
  code: ApiOrder["status"];
  label: string;
  description: string;
  tone: "green" | "amber" | "red" | string;
  manual: boolean; // an owner or editor may set it by hand
  retired: boolean; // no longer given to orders; only earlier status changes name it
};
export type OrderStatusChange = {
  id: string;
  fromStatus: ApiOrder["status"];
  toStatus: ApiOrder["status"];
  source: "manual" | "analysis";
  note: string | null; // always set for a manual change
  runId: string | null;
  changedBy: { id: string; name: string };
  changedAt: string;
};
// PATCH /orders/status: several orders set by hand with one note, all of them or none.
export type OrderStatusBulkChange = {
  changed: ApiOrder[];
  unchanged: string[]; // ids of orders that already had the status
};
// PATCH /orders/{id}: only the fields that changed. The order's id can't change.
export type OrderChange = Partial<
  Pick<
    Order,
    | "product"
    | "supplier"
    | "destination"
    | "value"
    | "currency"
    | "shipDate"
    | "hsCode"
  >
>;
// The order after the change and the analysis it ran: null when nothing changed or the
// analysis failed (the change is saved either way).
export type OrderUpdated = { detail: OrderDetail; run: AnalysisRun | null };
export type Overview = {
  totalOrders: number;
  countsByStatus: Record<string, number>;
  valueAtRiskByCurrency: Record<string, number>;
  nearestAffectedShipDate: string | null;
  sourcesCheckedAt: string | null;
};
export type OrderDetail = {
  order: ApiOrder;
  source: {
    importId: string;
    rowNumber: number;
    raw: Record<string, string>;
    rowHash: string;
  } | null;
  exposures: {
    reportId: string;
    requirementKey: string;
    title: string;
    status: string;
    note: string;
    source: RequirementSource;
  }[];
  latestReportId?: string | null; // the order's latest analysis report; null before any run
  statusChanges?: OrderStatusChange[]; // newest first
};
export type CostSetting = {
  key: string;
  label: string;
  unit: string; // "days", or a currency with `value` in hundredths
  value: number;
  source: "default" | "company_setting";
  defaultUnit: string;
  defaultValue: number;
};
export type CostLine = {
  kind: "missing_document" | "new_test" | "delay" | "duty";
  label: string;
  requirementKey: string | null;
  quantity: number;
  unitAmountMinor: number | null;
  baseAmountMinor: number | null;
  ratePercent: number | null;
  amountMinor: number;
  currency: string;
  formula: string;
  basis: {
    type: "regulation" | "company_setting" | "default";
    label: string;
    settingKey?: string | null;
    source?: RequirementSource | null;
  }[];
};
export type ReportState =
  | "pass"
  | "needs_data"
  | "rejected"
  | "needs_human_review";
export type AnalysisReport = {
  id: string;
  runId: string;
  state: ReportState;
  orderStatus: ApiOrder["status"];
  blocked: boolean;
  createdAt: string;
  order: ApiOrder;
  orderSource: { importId: string; rowNumber: number } | null;
  market: string | null;
  findings: RequirementCheck[];
  missingData: string[];
  daysUntilShip: number;
  costLines: CostLine[];
  costTotals: Record<string, number>;
  problemCostTotals: Record<string, number>;
  unpricedCosts: {
    kind: "duty";
    label: string;
    requirementKey: string;
    reason: string;
    source: RequirementSource;
  }[];
  rulesFired: {
    ruleId: string;
    text: string;
    action: string;
    note: string | null;
    conditions: string[];
  }[];
  rulesNotChecked: number;
  suggestedAction: {
    kind:
      | "complete_data"
      | "request_documents"
      | "move_ship_date"
      | "recheck_landed_cost"
      | "none";
    text: string;
    requestBy?: string | null;
  };
  audit: { passed: boolean; problems: string[] };
  review?: {
    reviewedBy: { id: string; name: string };
    reviewedAt: string;
    note: string | null;
  } | null;
  messageBlockedReason?: string | null;
  feedback?: {
    useful: number;
    notUseful: number;
    mine: boolean | null;
    myNote: string | null;
  } | null;
};
export type ReportFeedback = NonNullable<AnalysisReport["feedback"]>;
export type AnalysisRun = {
  id: string;
  status: "running" | "done" | "failed";
  orderCount: number;
  steps: {
    name: "relevance" | "exposure" | "cost" | "playbook" | "plan" | "auditor";
    summary: string;
  }[];
  playbookRevision: number;
  costSettings: CostSetting[];
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  reports: {
    id: string;
    orderId: string;
    state: ReportState;
    orderStatus: ApiOrder["status"];
    blocked: boolean;
    costTotals: Record<string, number>;
    missingData: string[];
  }[];
};
export type HsSuggestion = {
  id: string;
  hsCode: string;
  description: string;
  reason: string;
  basedOn: {
    type: "order" | "heading";
    ref: string;
    text: string;
    hsCode?: string | null;
  }[];
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  decidedAt: string | null;
};
export type SupplierMessage = {
  id: string;
  reportId: string;
  orderId: string;
  supplierId: string | null;
  status: "draft" | "approved" | "sent" | "failed";
  recipient: string | null;
  subject: string;
  body: string;
  createdBy: { id: string; name: string };
  createdAt: string;
  approvedBy: { id: string; name: string } | null;
  approvedAt: string | null;
  approvedByAuthor: boolean;
  sentAt: string | null;
  sandbox: boolean | null;
  error: string | null;
};
export type Solution = {
  id: string;
  market: string;
  requirementKey: string;
  problemStatus: string;
  summary: string;
  steps: string[];
  status: "suggested" | "adopted" | "rejected";
  writtenFor: string | null;
  basis: {
    regulationTitle: string;
    documentId: string;
    versionNumber: number;
    sourceUrl: string | null;
    quote: string;
  };
  validUntil: string;
  expired: boolean;
  expiredReason: string | null;
  model: string;
  createdBy: { id: string; name: string };
  createdAt: string;
  reviewedBy: { id: string; name: string } | null;
  reviewedAt: string | null;
  supersedesId: string | null;
  usedFor: number;
  notes: {
    id: string;
    author: { id: string; name: string };
    text: string;
    createdAt: string;
  }[];
};
// One problem in a report. `default` is never expired or rejected.
export type SolutionCase = {
  requirementKey: string;
  title: string;
  problemStatus: string;
  note: string;
  default: Solution | null;
  inUse: boolean;
  others: Solution[];
  expired: Solution[];
  needsAnalysis: boolean;
};
// One kind of problem in the knowledge base, with every solution saved for it.
export type SolutionProblem = {
  market: string;
  requirementKey: string;
  problemStatus: string;
  title: string;
  inChecklist: boolean;
  // Valid before expired; adopted, then suggested, then rejected; newest first.
  solutions: Solution[];
};
export type SupplierMessageUpdate = {
  recipient?: string | null;
  subject?: string;
  body?: string;
  saveRecipientToSupplier?: boolean;
};
export type RuleCondition = { field: string; op: string; value: unknown };
export type RuleAction = { action: string; note: string | null };
export type RuleFields = {
  fields: {
    key: string;
    label: string;
    type: "text" | "hs_code" | "number" | "money" | "document_kinds";
    ops: Record<string, string>;
    options: { value: string; label: string }[] | null;
  }[];
  actions: Record<string, string>;
  noValueOps: string[];
};
export type ReadDocumentFields = {
  kind: string | null;
  documentNumber: string | null;
  issuer: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  standards: string[];
  detail: string;
  notes: string | null;
};
export type SupplierDocumentUpload = {
  id: string;
  supplierId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: "draft" | "confirmed";
  extracted: ReadDocumentFields;
  createdAt: string;
  confirmedAt: string | null;
};
export type MarketRequirement = {
  id: string;
  marketCode: string;
  requirementKey: string;
  title: string;
  level: "supplier" | "shipment" | "check";
  documentKind: string | null;
  acceptedStandards: string[];
  form: string | null;
  hsPrefixes: string[];
  why: string;
  sourceQuote: string;
  quoteVerified: boolean;
  effectiveOn: string | null;
  dutyRatePercent: number | null;
  status: "draft" | "reviewed" | "rejected" | "replaced";
  shared: boolean;
  regulationDocumentId: string;
  reviewedAt: string | null;
};
export type MarketRequirementUpdate = Partial<
  Pick<
    MarketRequirement,
    | "marketCode"
    | "title"
    | "level"
    | "documentKind"
    | "acceptedStandards"
    | "form"
    | "hsPrefixes"
    | "why"
    | "sourceQuote"
    | "effectiveOn"
    | "dutyRatePercent"
  >
> & { status?: "reviewed" | "rejected" };
export type VersionRequirements = {
  regulationId: string;
  documentId: string;
  versionNumber: number;
  previousVersionNumber: number | null;
  inForce: boolean;
  requirements: MarketRequirement[];
  changes: {
    marketCode: string;
    requirementKey: string;
    title: string;
    change: "added" | "changed" | "removed";
    fields: string[];
  }[];
};
export type DraftedRequirements = VersionRequirements & {
  readAs: "text" | "scanned_file";
  sectionsSelected: boolean;
  dropped: Record<string, number>;
};
export type AuditEvent = {
  id: string;
  action: string;
  objectType: string;
  objectId: string;
  data: Record<string, unknown>;
  user: { id: string; name: string; email: string } | null;
  requestId: string | null;
  createdAt: string;
};
export type ContactMessage = {
  name: string;
  email: string;
  company: string | null;
  message: string;
  website: string; // hidden from people; bots fill it in
};
export type ReportEmail = {
  recipients: string[];
  sandbox: boolean;
  sentAt: string;
};
export type ReportRow = {
  id: string;
  cells: string[];
  tone: "gap" | "warn" | null;
  included: boolean;
};
export type ReportSection = {
  id: string;
  layout: "facts" | "table" | "sources";
  heading: string;
  note: string;
  empty: string;
  columns: string[];
  widths: number[];
  toneColumn: number | null;
  rows: ReportRow[];
  included: boolean;
};
export type ReportContent = {
  title: string;
  subtitle: string;
  summary: string;
  sections: ReportSection[];
};
export type ReportSummary = {
  id: string;
  kind: "order" | "company";
  title: string;
  scope: { orderId?: string; days?: number };
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  sentTo: string[] | null;
};
export type ReportDraft = ReportSummary & {
  companyName: string;
  preparedBy: string;
  content: ReportContent;
  original: ReportContent;
  edits: {
    header: boolean;
    sections: number;
    rowsEdited: number;
    rowsAdded: number;
    rowsRemoved: number;
  };
};
export type ImportPreview = {
  id: string;
  filename: string;
  status: "validated" | "invalid" | "committed";
  rowCount: number;
  errors: { row: number | null; field: string | null; message: string }[];
  preview: (Omit<ApiOrder, "status"> & { rowNumber: number })[];
  duplicateOfImportId: string | null;
};
export type GeoPoint = { latitude: number; longitude: number };
export type MapMarket = {
  code: string;
  name: string;
  shortName: string;
  hub: GeoPoint;
  countryIds: string[];
  searchTerms: string[];
};
export type CheckStatus =
  "on_file" | "missing" | "mismatch" | "prepare" | "check" | "unknown";
export type RequirementSource = {
  regulationId: string;
  documentTitle: string;
  regulationTitle: string;
  officialId: string | null;
  documentId: string;
  versionNumber: number;
  sourceUrl: string | null;
  quote: string;
};
export type RequirementCheck = {
  source?: RequirementSource;
  requirementKey: string;
  title: string;
  level: "supplier" | "shipment" | "check";
  status: CheckStatus;
  note: string;
  // The supplier document that answers it and the standards it accepts. Absent from
  // analysis reports saved before the backend added them.
  documentKind?: string | null;
  acceptedStandards?: string[];
};
// A checklist line that takes effect or changes soon in a market the company ships to.
export type ChecklistChange = {
  on: string;
  kind: "effective" | "changes";
  market: string;
  marketName: string;
  requirementKey: string;
  title: string;
  whatChanges: string;
  orderIds: string[]; // open orders to that market shipping on or after `on`
  source: RequirementSource;
};
export type ChecklistChanges = {
  start: string;
  until: string;
  days: number; // the window the backend used (RULE_WATCH_DAYS unless asked)
  changes: ChecklistChange[];
};
export type MapOrder = {
  order: ApiOrder;
  placement: {
    city: string;
    country: string | null;
    market: string | null;
    location: GeoPoint | null;
    approximate: boolean;
  };
  checks: RequirementCheck[];
  gapCount: number;
};
export type MapSupplier = {
  id: string | null;
  name: string;
  place: string | null;
  country: string | null;
  location: GeoPoint | null;
  supplies: string | null;
  contactName?: string | null;
  contactEmail?: string | null; // supplier messages are pre-filled with it
  documents:
    | {
        kind: string;
        label: string;
        detail: string;
        standards: string[];
        documentNumber?: string | null;
        issuer?: string | null;
        expiresOn?: string | null;
        fromUpload?: boolean;
      }[]
    | null;
  orderIds: string[];
};
export type MapSite = {
  id: string;
  key: string;
  kind: "factory" | "port" | "warehouse";
  name: string;
  shortName: string;
  place: string;
  country: string | null;
  location: GeoPoint;
  note: string;
  isRouteOrigin: boolean;
};
export type NearbyPlace = {
  type: "supplier" | "site";
  ref: string;
  name: string;
  distanceKm: number;
};
export type SatelliteObservation = {
  id: string;
  kind: string;
  title: string;
  place: string;
  center: GeoPoint;
  radiusKm: number;
  areaKm2: number;
  observedOn: string;
  sensor: string;
  confidence: "high" | "low";
  confidenceNote: string;
  extent: Polygon;
  isSample: boolean;
  sourceUrl: string | null;
  nearby: NearbyPlace[];
};
export type TradeMap = {
  markets: MapMarket[];
  orders: MapOrder[];
  suppliers: MapSupplier[];
  sites: MapSite[];
  observations: SatelliteObservation[];
  documentKinds: { kind: string; label: string }[];
  countries: { code: string; numericCode: string; name: string }[];
  homeCountryIds: string[];
  checkRadiusKm: number;
};
export type SupplierDocumentInput = {
  kind: string;
  detail: string;
  standards: string[];
  documentNumber: string | null;
  issuer: string | null;
  expiresOn: string | null; // YYYY-MM-DD; before an order's ship date it is a mismatch
};
export type SupplierInput = {
  name: string;
  place: string | null;
  country: string | null;
  location: GeoPoint | null;
  supplies: string | null;
  contactName: string | null;
  contactEmail: string | null;
  documents: SupplierDocumentInput[];
};
export type SupplierRecord = Omit<SupplierInput, "documents"> & {
  id: string;
  documents: NonNullable<MapSupplier["documents"]>;
  // Orders the save analysed again (a new name or new documents changes their checks).
  analysedOrderIds: string[];
};
export type SiteInput = {
  kind: MapSite["kind"];
  name: string;
  shortName: string;
  place: string;
  country: string | null;
  location: GeoPoint;
  note: string;
  isRouteOrigin: boolean;
};
export type ComparisonItem = {
  title: string;
  note: string;
  tag: "New" | "Changes" | "Prepare" | null;
};
export type MarketComparison = {
  orderId: string;
  kind: "market" | "ship_date" | "route";
  fromMarket: string | null;
  toMarket: string;
  fromShipDate?: string | null;
  toShipDate?: string | null;
  via?: string | null;
  viaName?: string | null;
  distanceKm?: number | null;
  routePoints?: GeoPoint[];
  reuse: ComparisonItem[];
  reevaluate: ComparisonItem[];
  unknown: ComparisonItem[];
  dropped: string[];
  assumptions?: string[];
};
export type ScenarioKind = "market" | "ship_date" | "route";
export type SavedScenario = {
  id: string;
  orderId: string;
  kind: ScenarioKind;
  target: string;
  label: string;
  note: string | null;
  comparison: MarketComparison; // as it stood when saved
  createdBy: { id: string; name: string } | null;
  updatedBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
};
export type ScenarioPoint = { text: string; items: string[] };
export type ScenarioSuggestion = {
  summary: string;
  nextSteps: ScenarioPoint[];
  questions: ScenarioPoint[];
  note: string;
};
export type RegulationDocument = {
  id: string;
  title: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
  sourceUrl: string | null;
  regulationId: string;
  versionNumber: number;
  createdAt: string;
};
export type Regulation = {
  id: string;
  title: string;
  officialId: string | null;
  shared: boolean;
  versionCount: number;
  latestVersion: RegulationDocument | null;
  createdAt: string;
};
export type RegulationDetail = Regulation & { versions: RegulationDocument[] };
type Envelope<T> = {
  data: T;
  meta: { nextCursor?: string | null; total?: number; revision?: number };
};
export type NewsVerdict = "relevant" | "not_relevant";
// An order a News watch alert may affect: suggested (same HS heading and market as a stock
// item the alert names), linked by a person, or both, with the person's verdict once given.
export type NewsMatch = {
  impactId: string;
  orderId: string;
  product: string;
  destination: string;
  market: string | null;
  shipDate: string;
  suggested: boolean;
  reason: string;
  review: {
    verdict: NewsVerdict;
    note: string | null;
    reviewedBy: { id: string; name: string };
    reviewedAt: string;
  } | null;
};
export type Role = "owner" | "editor" | "viewer";
// GET /company/members: everyone in the company. Owners change roles and remove people.
export type Member = {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
  you: boolean;
};
// GET /company/invites (owners): addresses invited to join, until they accept or it expires.
export type Invite = {
  id: string;
  email: string;
  role: Role;
  invitedBy: { id: string; name: string } | null;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
};
// GET /me/invites: invitations to the signed-in person's own address.
export type ReceivedInvite = {
  id: string;
  companyName: string;
  role: Role;
  invitedBy: { id: string; name: string } | null;
  expiresAt: string;
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}
const base = (import.meta.env.VITE_BACKEND_API_URL || "/api/v1").replace(
  /\/$/,
  "",
);
async function authenticatedResponse(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${await getToken()}`);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(base + path, {
    ...options,
    headers,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  if (!response.ok) throw await responseError(response);
  return response;
}
async function responseError(response: Response): Promise<ApiError> {
  const body = await response.json().catch(() => null);
  const fields = body?.error?.fieldErrors;
  const details = fields
    ? Object.entries(fields)
        .map(([key, value]) => `${key}: ${value}`)
        .join("; ")
    : "";
  return new ApiError(
    [body?.error?.message || `Request failed (${response.status}).`, details]
      .filter(Boolean)
      .join(" "),
    response.status,
    body?.error?.code || "request_failed",
  );
}
export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<Envelope<T>> {
  const response = await authenticatedResponse(path, options);
  const body = await response.json().catch(() => null);
  if (!body || !("data" in body))
    throw new Error(
      "The backend returned an unexpected response. Check the API deployment configuration.",
    );
  return body;
}
export function asOrder(order: ApiOrder): Order {
  return {
    ...order,
    value: order.valueMinor / 100,
    risk: order.status === "exposed",
  };
}
export function cacheAccount(account: Account): Profile {
  const profile: Profile = {
    ...defaultProfile,
    ...account.user,
    company: account.company?.name || "",
    role: account.company?.businessRole || "Manufacturer",
    origin: account.company?.origin || "Vietnam",
    transit: account.company?.transit ?? defaultProfile.transit,
    destination: account.company?.destination || "European Union",
    description: account.company?.description || "",
    products: account.company?.products || "",
    materials: account.company?.materials || "",
    certifications: account.company?.certifications || "",
    website: account.company?.website || "",
    foundedYear: account.company?.foundedYear
      ? String(account.company.foundedYear)
      : "",
    teamSize: account.company?.teamSize || "",
    onboarded: account.onboarded,
  };
  putProfile(profile);
  return profile;
}
export const api = {
  me: (signal?: AbortSignal) =>
    request<Account>("/me", { signal }).then((r) => r.data),
  updateMe: (p: Pick<Profile, "name" | "alerts" | "digest">) =>
    request<Account>("/me", { method: "PATCH", body: JSON.stringify(p) }).then(
      (r) => r.data,
    ),
  updateCompany: (p: Profile) =>
    request("/company", {
      method: "PATCH",
      body: JSON.stringify({
        name: p.company,
        businessRole: p.role,
        origin: p.origin,
        transit: p.transit,
        destination: p.destination,
        description: p.description,
        products: p.products,
        materials: p.materials,
        certifications: p.certifications,
        // Empty optional fields are sent as null, which clears them.
        website: p.website.trim() || null,
        foundedYear: p.foundedYear ? Number(p.foundedYear) : null,
        teamSize: p.teamSize || null,
      }),
    }),
  onboard: (p: Profile) =>
    request<Account>("/onboarding", {
      method: "POST",
      body: JSON.stringify({
        companyName: p.company,
        businessRole: p.role,
        origin: p.origin,
        transit: p.transit,
        destination: p.destination,
        currency: "USD",
        description: p.description.trim(),
      }),
    }).then((r) => r.data),
  logout: () => request("/me/logout", { method: "POST" }),
  overview: (signal?: AbortSignal) =>
    request<Overview>("/overview", { signal }).then((r) => r.data),
  async orders(signal?: AbortSignal) {
    const orders: Order[] = [];
    let cursor: string | null | undefined;
    do {
      const query = new URLSearchParams({ limit: "200" });
      if (cursor) query.set("cursor", cursor);
      const page = await request<ApiOrder[]>(`/orders?${query}`, { signal });
      orders.push(...page.data.map(asOrder));
      cursor = page.meta.nextCursor;
    } while (cursor);
    return orders;
  },
  detail: (id: string) =>
    request<OrderDetail>(`/orders/${encodeURIComponent(id)}`).then(
      (r) => r.data,
    ),
  orderStatuses: (signal?: AbortSignal) =>
    request<OrderStatusOption[]>("/order-statuses", { signal }).then(
      (r) => r.data,
    ),
  changeOrderStatus: (id: string, status: ApiOrder["status"], note: string) =>
    request<OrderDetail>(`/orders/${encodeURIComponent(id)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status, note }),
    }).then((r) => r.data),
  changeOrderStatuses: (
    ids: string[],
    status: ApiOrder["status"],
    note: string,
  ) =>
    request<OrderStatusBulkChange>("/orders/status", {
      method: "PATCH",
      body: JSON.stringify({ orderIds: ids, status, note }),
    }).then((r) => r.data),
  updateOrder: (id: string, { value, ...change }: OrderChange) =>
    request<OrderUpdated>(`/orders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...change,
        // Hundredths of the currency unit, as the backend keeps every amount.
        ...(value === undefined ? {} : { valueMinor: Math.round(value * 100) }),
      }),
    }).then((r) => r.data),
  deleteOrder: (id: string) =>
    request(`/orders/${encodeURIComponent(id)}`, { method: "DELETE" }),
  reports: (signal?: AbortSignal) =>
    request<ReportSummary[]>("/report-drafts", { signal }).then((r) => r.data),
  report: (id: string, signal?: AbortSignal) =>
    request<ReportDraft>(`/report-drafts/${encodeURIComponent(id)}`, { signal }).then(
      (r) => r.data,
    ),
  createReport: (
    body: { kind: "order"; orderId: string } | { kind: "company"; days: number },
  ) =>
    request<ReportDraft>("/report-drafts", {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.data),
  updateReport: (id: string, content: ReportContent) =>
    request<ReportDraft>(`/report-drafts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    }).then((r) => r.data),
  async reportPdf(id: string): Promise<Blob> {
    const response = await authenticatedResponse(
      `/report-drafts/${encodeURIComponent(id)}/pdf`,
    );
    return response.blob();
  },
  async downloadReport(id: string) {
    const response = await authenticatedResponse(
      `/report-drafts/${encodeURIComponent(id)}/pdf?download=true`,
    );
    const filename =
      /filename="([^"]+)"/.exec(
        response.headers.get("content-disposition") || "",
      )?.[1] || "exportmate-report.pdf";
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
  // One key per dialog: a double click or a retry sends one email.
  emailReport: (
    id: string,
    body: { to: string[]; message: string },
    idempotencyKey: string,
  ) =>
    request<ReportEmail>(`/report-drafts/${encodeURIComponent(id)}/email`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    }).then((r) => r.data),
  rules: (signal?: AbortSignal) =>
    request<Rule[]>("/playbook/rules", { signal }).then((r) => r.data),
  addRule: (rule: Omit<Rule, "id">) =>
    request<Rule>("/playbook/rules", {
      method: "POST",
      body: JSON.stringify(rule),
    }).then((r) => r.data),
  toggleRule: (rule: Rule) =>
    request<Rule>(`/playbook/rules/${rule.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !rule.enabled }),
    }).then((r) => r.data),
  deleteRule: (id: string) =>
    request(`/playbook/rules/${id}`, { method: "DELETE" }),
  upload: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<ImportPreview>("/imports", {
      method: "POST",
      body: form,
    }).then((r) => r.data);
  },
  import: (id: string) =>
    request<ImportPreview>(`/imports/${id}`).then((r) => r.data),
  // Commits the import and analyses the new orders; run is null when the analysis failed.
  commit: (id: string) =>
    request<{ ordersCreated: number; run: AnalysisRun | null }>(`/imports/${id}/commit`, {
      method: "POST",
    }).then((r) => r.data),
  regulations: (signal?: AbortSignal) =>
    request<Regulation[]>("/regulations", { signal }).then((r) => r.data),
  regulation: (id: string, signal?: AbortSignal) =>
    request<RegulationDetail>(`/regulations/${encodeURIComponent(id)}`, {
      signal,
    }).then((r) => r.data),
  regulationDocument: (id: string, signal?: AbortSignal) =>
    request<RegulationDocument>(
      `/regulation-documents/${encodeURIComponent(id)}`,
      { signal },
    ).then((r) => r.data),
  uploadRegulation: (form: FormData) =>
    request<RegulationDocument>("/regulation-documents", {
      method: "POST",
      body: form,
    }).then((r) => r.data),
  async downloadRegulation(id: string, filename: string) {
    const response = await authenticatedResponse(
      `/regulation-documents/${encodeURIComponent(id)}/file`,
    );
    // Files are attachments, including HTML: never embed uploaded content in our origin.
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
  tradeMap: (signal?: AbortSignal) =>
    request<TradeMap>("/trade-map", { signal }).then((r) => r.data),
  // The window is the backend's RULE_WATCH_DAYS setting.
  checklistChanges: (signal?: AbortSignal) =>
    request<ChecklistChanges>("/trade-map/changes", { signal }).then(
      (r) => r.data,
    ),
  // `analysedOrderIds` defaults to none: a backend deployed before it was added doesn't
  // send it (Vercel deploys the frontend first).
  createSupplier: (supplier: SupplierInput) =>
    request<SupplierRecord>("/suppliers", {
      method: "POST",
      body: JSON.stringify(supplier),
    }).then((r) => ({ ...r.data, analysedOrderIds: r.data.analysedOrderIds ?? [] })),
  // Sends every field: null clears place, country, location and supplies.
  updateSupplier: (id: string, supplier: SupplierInput) =>
    request<SupplierRecord>(`/suppliers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(supplier),
    }).then((r) => ({ ...r.data, analysedOrderIds: r.data.analysedOrderIds ?? [] })),
  deleteSupplier: (id: string) =>
    request<{ deleted: boolean; analysedOrderIds?: string[] }>(
      `/suppliers/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ).then((r) => ({ analysedOrderIds: r.data.analysedOrderIds ?? [] })),
  createSite: (site: SiteInput) =>
    request<MapSite>("/sites", {
      method: "POST",
      body: JSON.stringify(site),
    }).then((r) => r.data),
  updateSite: (id: string, site: SiteInput) =>
    request<MapSite>(`/sites/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(site),
    }).then((r) => r.data),
  deleteSite: (id: string) =>
    request(`/sites/${encodeURIComponent(id)}`, { method: "DELETE" }),
  compareMarkets: (orderId: string, market: string, signal?: AbortSignal) =>
    request<MarketComparison>(
      `/trade-map/compare?${new URLSearchParams({ orderId, market })}`,
      { signal },
    ).then((r) => r.data),
  compareShipDate: (orderId: string, shipDate: string, signal?: AbortSignal) =>
    request<MarketComparison>(
      `/trade-map/compare?${new URLSearchParams({ orderId, shipDate })}`,
      { signal },
    ).then((r) => r.data),
  compareRoute: (orderId: string, via: string, signal?: AbortSignal) =>
    request<MarketComparison>(
      `/trade-map/compare?${new URLSearchParams({ orderId, via })}`,
      { signal },
    ).then((r) => r.data),
  // What-ifs saved with a note; saving changes nothing on the order.
  scenarios: (orderId?: string, signal?: AbortSignal) =>
    request<SavedScenario[]>(
      `/trade-map/scenarios${orderId ? `?${new URLSearchParams({ orderId })}` : ""}`,
      { signal },
    ).then((r) => r.data),
  saveScenario: (scenario: {
    orderId: string;
    kind: ScenarioKind;
    target: string;
    note: string | null;
  }) =>
    request<SavedScenario>("/trade-map/scenarios", {
      method: "POST",
      body: JSON.stringify(scenario),
    }).then((r) => r.data),
  updateScenarioNote: (id: string, note: string | null) =>
    request<SavedScenario>(`/trade-map/scenarios/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ note }),
    }).then((r) => r.data),
  deleteScenario: (id: string) =>
    request(`/trade-map/scenarios/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  suggestScenarioNote: (what: {
    orderId: string;
    kind: ScenarioKind;
    target: string;
  }) =>
    request<ScenarioSuggestion>("/trade-map/scenarios/suggest", {
      method: "POST",
      body: JSON.stringify(what),
    }).then((r) => r.data),
  // Analysis: every order when orderIds is omitted. Returns the finished run.
  startRun: (orderIds?: string[]) =>
    request<AnalysisRun>("/runs", {
      method: "POST",
      body: JSON.stringify(orderIds ? { orderIds } : {}),
    }).then((r) => r.data),
  run: (id: string, signal?: AbortSignal) =>
    request<AnalysisRun>(`/runs/${encodeURIComponent(id)}`, { signal }).then(
      (r) => r.data,
    ),
  analysisReport: (id: string, signal?: AbortSignal) =>
    request<AnalysisReport>(`/reports/${encodeURIComponent(id)}`, {
      signal,
    }).then((r) => r.data),
  reviewReport: (id: string, note: string | null) =>
    request<AnalysisReport>(`/reports/${encodeURIComponent(id)}/review`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }).then((r) => r.data),
  reportFeedback: (id: string, useful: boolean, note: string | null) =>
    request<ReportFeedback>(`/reports/${encodeURIComponent(id)}/feedback`, {
      method: "POST",
      body: JSON.stringify({ useful, note }),
    }).then((r) => r.data),
  costSettings: (signal?: AbortSignal) =>
    request<CostSetting[]>("/company/cost-settings", { signal }).then(
      (r) => r.data,
    ),
  // value null: back to the default.
  updateCostSettings: (
    settings: { key: string; value: number | null; unit?: string }[],
  ) =>
    request<CostSetting[]>("/company/cost-settings", {
      method: "PATCH",
      body: JSON.stringify({ settings }),
    }).then((r) => r.data),
  hsSuggestions: (orderId: string, signal?: AbortSignal) =>
    request<HsSuggestion[]>(
      `/orders/${encodeURIComponent(orderId)}/hs-suggestions`,
      { signal },
    ).then((r) => r.data),
  suggestHsCodes: (orderId: string) =>
    request<HsSuggestion[]>(
      `/orders/${encodeURIComponent(orderId)}/hs-suggestions`,
      { method: "POST" },
    ).then((r) => r.data),
  acceptHsSuggestion: (id: string) =>
    request<{ suggestion: HsSuggestion; order: ApiOrder; run: AnalysisRun }>(
      `/hs-suggestions/${encodeURIComponent(id)}/accept`,
      { method: "POST" },
    ).then((r) => r.data),
  rejectHsSuggestion: (id: string) =>
    request<HsSuggestion>(`/hs-suggestions/${encodeURIComponent(id)}/reject`, {
      method: "POST",
    }).then((r) => r.data),
  ruleFields: (signal?: AbortSignal) =>
    request<RuleFields>("/playbook/fields", { signal }).then((r) => r.data),
  // Both when and then to make a rule checked, or both null to keep it stored only.
  updateRule: (
    id: string,
    change: Partial<Pick<Rule, "text" | "category" | "enabled">> & {
      when?: RuleCondition[] | null;
      then?: RuleAction | null;
    },
  ) =>
    request<Rule>(`/playbook/rules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(change),
    }).then((r) => r.data),
  uploadSupplierDocument: (supplierId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<SupplierDocumentUpload>(
      `/suppliers/${encodeURIComponent(supplierId)}/documents`,
      { method: "POST", body: form },
    ).then((r) => r.data);
  },
  confirmSupplierDocument: (uploadId: string, fields: SupplierDocumentInput) =>
    request(`/supplier-documents/${encodeURIComponent(uploadId)}/confirm`, {
      method: "POST",
      body: JSON.stringify(fields),
    }),
  versionRequirements: (
    regulationId: string,
    version?: number,
    signal?: AbortSignal,
  ) =>
    request<VersionRequirements>(
      `/regulations/${encodeURIComponent(regulationId)}/requirements${version ? `?version=${version}` : ""}`,
      { signal },
    ).then((r) => r.data),
  draftRequirements: (documentId: string) =>
    request<DraftedRequirements>(
      `/regulation-documents/${encodeURIComponent(documentId)}/requirements`,
      { method: "POST" },
    ).then((r) => r.data),
  reviewRequirement: (id: string, change: MarketRequirementUpdate) =>
    request<MarketRequirement>(
      `/market-requirements/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(change) },
    ).then((r) => r.data),
  draftSupplierMessage: (reportId: string, recipient?: string) =>
    request<SupplierMessage>("/supplier-messages", {
      method: "POST",
      body: JSON.stringify(recipient ? { reportId, recipient } : { reportId }),
    }).then((r) => r.data),
  supplierMessages: (orderId: string, signal?: AbortSignal) =>
    request<SupplierMessage[]>(
      `/orders/${encodeURIComponent(orderId)}/supplier-messages`,
      { signal },
    ).then((r) => r.data),
  updateSupplierMessage: (id: string, change: SupplierMessageUpdate) =>
    request<SupplierMessage>(`/supplier-messages/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(change),
    }).then((r) => r.data),
  approveSupplierMessage: (id: string) =>
    request<SupplierMessage>(
      `/supplier-messages/${encodeURIComponent(id)}/approve`,
      { method: "POST" },
    ).then((r) => r.data),
  // One key per send attempt: a double click or a retry sends one email.
  sendSupplierMessage: (id: string, idempotencyKey: string) =>
    request<SupplierMessage>(
      `/supplier-messages/${encodeURIComponent(id)}/send`,
      { method: "POST", headers: { "Idempotency-Key": idempotencyKey } },
    ).then((r) => r.data),
  solutions: (signal?: AbortSignal) =>
    request<SolutionProblem[]>("/solutions", { signal }).then((r) => r.data),
  reportSolutions: (reportId: string, signal?: AbortSignal) =>
    request<SolutionCase[]>(
      `/reports/${encodeURIComponent(reportId)}/solutions`,
      { signal },
    ).then((r) => r.data),
  suggestSolution: (reportId: string, requirementKey: string) =>
    request<SolutionCase>(
      `/reports/${encodeURIComponent(reportId)}/solutions`,
      { method: "POST", body: JSON.stringify({ requirementKey }) },
    ).then((r) => r.data),
  useSolution: (id: string, reportId: string) =>
    request<SolutionCase>(`/solutions/${encodeURIComponent(id)}/use`, {
      method: "POST",
      body: JSON.stringify({ reportId }),
    }).then((r) => r.data),
  addSolutionNote: (id: string, text: string) =>
    request<Solution>(`/solutions/${encodeURIComponent(id)}/notes`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }).then((r) => r.data),
  reviewSolution: (
    id: string,
    verdict: "adopted" | "rejected",
    note: string | null,
  ) =>
    request<Solution>(`/solutions/${encodeURIComponent(id)}/review`, {
      method: "POST",
      body: JSON.stringify({ verdict, note }),
    }).then((r) => r.data),
  async auditEvents(
    filter: { objectType?: string; userId?: string; limit?: number },
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({ limit: String(filter.limit ?? 50) });
    if (filter.objectType) query.set("objectType", filter.objectType);
    if (filter.userId) query.set("userId", filter.userId);
    const page = await request<AuditEvent[]>(`/audit-events?${query}`, {
      signal,
    });
    return { events: page.data, more: Boolean(page.meta.nextCursor) };
  },
  // The whole log with the same filters, as a CSV file.
  async downloadAuditEvents(filter: { objectType?: string; userId?: string }) {
    const query = new URLSearchParams();
    if (filter.objectType) query.set("objectType", filter.objectType);
    if (filter.userId) query.set("userId", filter.userId);
    const response = await authenticatedResponse(`/audit-events/export?${query}`);
    const filename =
      /filename="([^"]+)"/.exec(
        response.headers.get("content-disposition") || "",
      )?.[1] || "exportmate-activity.csv";
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
  newsMatches: (signal?: AbortSignal) =>
    request<{ newsAvailable: boolean; matches: NewsMatch[] }>("/news-matches", {
      signal,
    }).then((r) => r.data),
  reviewNewsMatch: (
    impactId: string,
    orderId: string,
    verdict: NewsVerdict,
    note: string | null,
  ) =>
    request<NewsMatch>(
      `/news-matches/${encodeURIComponent(impactId)}/orders/${encodeURIComponent(orderId)}`,
      { method: "PUT", body: JSON.stringify({ verdict, note }) },
    ).then((r) => r.data),
  clearNewsReview: (impactId: string, orderId: string) =>
    request(
      `/news-matches/${encodeURIComponent(impactId)}/orders/${encodeURIComponent(orderId)}`,
      { method: "DELETE" },
    ),
  members: (signal?: AbortSignal) =>
    request<Member[]>("/company/members", { signal }).then((r) => r.data),
  changeMemberRole: (userId: string, role: Role) =>
    request<Member>(`/company/members/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }).then((r) => r.data),
  // An owner removing someone, or anyone leaving (their own user ID).
  removeMember: (userId: string) =>
    request(`/company/members/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    }),
  invites: (signal?: AbortSignal) =>
    request<Invite[]>("/company/invites", { signal }).then((r) => r.data),
  inviteMember: (email: string, role: Role) =>
    request<Invite & { sandbox: boolean }>("/company/invites", {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }).then((r) => r.data),
  revokeInvite: (id: string) =>
    request(`/company/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),
  receivedInvites: (signal?: AbortSignal) =>
    request<ReceivedInvite[]>("/me/invites", { signal }).then((r) => r.data),
  acceptInvite: (id: string) =>
    request<Account>(`/me/invites/${encodeURIComponent(id)}/accept`, {
      method: "POST",
    }).then((r) => r.data),
  declineInvite: (id: string) =>
    request(`/me/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

// The public contact form: no sign-in, so no token.
export async function sendContactMessage(message: ContactMessage) {
  const response = await fetch(base + "/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw await responseError(response);
}
