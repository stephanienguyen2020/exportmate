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
  exposures: unknown[];
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
  location: GeoPoint | null;
  supplies: string | null;
  documents:
    | { kind: string; label: string; detail: string; standards: string[] }[]
    | null;
  orderIds: string[];
};
export type MapSite = {
  key: string;
  kind: "factory" | "port" | "warehouse";
  name: string;
  shortName: string;
  place: string;
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
  homeCountryIds: string[];
  checkRadiusKm: number;
};
export type ComparisonItem = {
  title: string;
  note: string;
  tag: "New" | "Changes" | null;
};
export type MarketComparison = {
  orderId: string;
  fromMarket: string | null;
  toMarket: string;
  reuse: ComparisonItem[];
  reevaluate: ComparisonItem[];
  unknown: ComparisonItem[];
  dropped: string[];
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
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const fields = body?.error?.fieldErrors;
    const details = fields
      ? Object.entries(fields)
          .map(([key, value]) => `${key}: ${value}`)
          .join("; ")
      : "";
    throw new ApiError(
      [body?.error?.message || `Request failed (${response.status}).`, details]
        .filter(Boolean)
        .join(" "),
      response.status,
      body?.error?.code || "request_failed",
    );
  }
  return response;
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
  commit: (id: string) =>
    request<{ ordersCreated: number }>(`/imports/${id}/commit`, {
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
  compareMarkets: (orderId: string, market: string, signal?: AbortSignal) =>
    request<MarketComparison>(
      `/trade-map/compare?${new URLSearchParams({ orderId, market })}`,
      { signal },
    ).then((r) => r.data),
};
