import {
  geoArea,
  geoMercator,
  geoNaturalEarth1,
  type GeoProjection,
} from "d3-geo";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import type { Feature, FeatureCollection, Geometry, Polygon } from "geojson";
import world110Url from "world-atlas/countries-110m.json?url";
import world50Url from "world-atlas/countries-50m.json?url";
import { date, type Order } from "../data";
import {
  type GeoPoint,
  type MapMarket,
  type MapOrder,
  type MapSite,
  type MapSupplier,
  type RequirementCheck,
  type SatelliteObservation,
} from "../api";

// Map geometry is presentation: the data (places, documents, checklists,
// observations) comes from the backend's /trade-map, stored in Postgres.
export const W = 960;

export const H = 480;

// Under the Pacific-centred rotation these points span the full width and
// latitudes 56°S–80°N, which keeps Antarctica out of the frame.
const WORLD_FRAME = {
  type: "MultiPoint" as const,
  coordinates: [
    [-29.9, 0],
    [-30.1, 0],
    [150, 80],
    [150, -56],
  ],
};

export type LonLat = [number, number];

export type LabelSide = "left" | "right" | "top" | "bottom";

export type Tone = "red" | "amber" | "green";

export type ViewId = "world" | "production" | "europe" | "americas" | "asia" | "focus";

export type View = { id: ViewId; label: string; bounds?: [LonLat, LonLat] };

// Camera presets for market regions. The production view is fitted to the
// company's own sites and suppliers instead.
export const MARKET_VIEWS: View[] = [
  {
    id: "europe",
    label: "Europe",
    bounds: [
      [-10, 37],
      [24, 58],
    ],
  },
  {
    id: "americas",
    label: "North America",
    bounds: [
      [-128, 25],
      [-64, 52],
    ],
  },
  {
    id: "asia",
    label: "Asia-Pacific",
    bounds: [
      [98, -38],
      [154, 40],
    ],
  },
];

export const WORLD_VIEW: View = { id: "world", label: "World" };

export type Selection =
  | { kind: "market"; code: string }
  | { kind: "supplier"; name: string }
  | { kind: "site"; id: string }
  | { kind: "flood"; id: string };

export type ScenarioMode = "market" | "date" | "route";

export type Scenario = { orderId: string; mode: ScenarioMode; target: string | null };

export type Row = {
  order: Order;
  placement: MapOrder["placement"];
  checks: RequirementCheck[];
  gaps: RequirementCheck[];
};

export type SupplierGroup = {
  key: string;
  id: string | null; // null: named on orders, no supplier record
  name: string;
  country: string | null;
  place: string | null;
  at: LonLat | null;
  supplies: string | null;
  contactName: string | null;
  contactEmail: string | null;
  documents: MapSupplier["documents"];
  rows: Row[];
};

export type FloodEntry = {
  flood: SatelliteObservation;
  suppliers: { group: SupplierGroup; km: number }[];
  sites: { site: MapSite; km: number }[];
};

export type MarketSummary = { market: MapMarket; rows: Row[]; tone: Tone };

// An open supplier or site form. `group`/`site` null adds a new one.
export type Editing =
  | { type: "supplier"; group: SupplierGroup | null; name?: string }
  | { type: "site"; site: MapSite | null };

// The location being entered. `picked` counts map clicks, so a form can tell a
// click (which also suggests the country) from typed coordinates.
export type Pin = { at: LonLat; country: string | null; picked: number };

export type Marker = {
  key: string;
  kind: "market" | "port" | "supplier" | "site" | "origin" | "flood";
  x: number;
  y: number;
  label: string;
  aria: string;
  tone: Tone | "neutral" | "water";
  count: number;
  side: LabelSide;
  market?: string;
  supplier?: string;
  siteId?: string;
  floodId?: string;
  origin?: boolean;
};

export type Focus = {
  markets: Set<string>;
  suppliers: Set<string>;
  sites: Set<string>;
  floods: Set<string>;
};

export type Atlas = Feature<Geometry, { name: string }>[];

const atlasCache: Partial<Record<"110m" | "50m", Promise<Atlas>>> = {};

export function loadAtlas(detail: "110m" | "50m") {
  atlasCache[detail] ??= fetch(detail === "110m" ? world110Url : world50Url)
    .then((response) => {
      if (!response.ok)
        throw new Error(`Map outlines failed (${response.status})`);
      return response.json();
    })
    .then(
      (
        topology: Topology<{ countries: GeometryCollection<{ name: string }> }>,
      ) =>
        (
          feature(topology, topology.objects.countries) as FeatureCollection<
            Geometry,
            { name: string }
          >
        ).features,
    )
    .catch((error) => {
      delete atlasCache[detail];
      throw error;
    });
  return atlasCache[detail]!;
}

export function projectionFor(view: View): GeoProjection {
  if (!view.bounds)
    return geoNaturalEarth1()
      .rotate([-150, 0])
      .fitExtent(
        [
          [12, 12],
          [W - 12, H - 12],
        ],
        WORLD_FRAME,
      )
      .clipExtent([
        [0, 0],
        [W, H],
      ]);
  return geoMercator()
    .fitExtent(
      [
        [28, 28],
        [W - 28, H - 28],
      ],
      { type: "MultiPoint", coordinates: view.bounds },
    )
    .clipExtent([
      [0, 0],
      [W, H],
    ]);
}

const TONE_RANK: Record<Tone, number> = { red: 0, amber: 1, green: 2 };

export const worst = (tones: Tone[]): Tone =>
  tones.reduce<Tone>((a, b) => (TONE_RANK[b] < TONE_RANK[a] ? b : a), "green");

// Same rule as the backend's supplier_name_key.
export const supplierKey = (name: string) =>
  name.trim().split(/\s+/).join(" ").toLowerCase();

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const pct = (value: number, total: number) => `${(value / total) * 100}%`;

export const byShipDate = (a: Row, b: Row) =>
  a.order.shipDate.localeCompare(b.order.shipDate);

export const productKey = (s: string) =>
  s.toLowerCase().replace(/[·,]/g, " ").replace(/\s+/g, " ").trim();

export const lonLat = (p: GeoPoint): LonLat => [p.longitude, p.latitude];

export const isGap = (c: RequirementCheck) =>
  c.status === "missing" || c.status === "mismatch";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const marketTerms = (market: MapMarket) =>
  market.searchTerms.length
    ? new RegExp(
        `(?<!\\w)(${market.searchTerms.map(escapeRegExp).join("|")})(?!\\w)`,
      )
    : null;

// GeoJSON (RFC 7946) winds outer rings counter-clockwise; d3-geo expects the
// opposite and would otherwise fill the whole globe except the shape.
export function forD3(polygon: Polygon): Polygon {
  return geoArea(polygon) > 2 * Math.PI
    ? {
        ...polygon,
        coordinates: polygon.coordinates.map((ring) => [...ring].reverse()),
      }
    : polygon;
}

// A view around the company's own places, at least a few degrees across.
export function productionView(points: LonLat[]): View | null {
  if (!points.length) return null;
  const lons = points.map((p) => p[0]),
    lats = points.map((p) => p[1]);
  const pad = (lo: number, hi: number) =>
    Math.max(1.2, (hi - lo) * 0.15, (4 - (hi - lo)) / 2);
  const [lon0, lon1] = [Math.min(...lons), Math.max(...lons)];
  const [lat0, lat1] = [Math.min(...lats), Math.max(...lats)];
  const padLon = pad(lon0, lon1),
    padLat = pad(lat0, lat1);
  return {
    id: "production",
    label: "Production",
    bounds: [
      [lon0 - padLon, lat0 - padLat],
      [lon1 + padLon, lat1 + padLat],
    ],
  };
}

// Country anchors for a company that named an origin but has not recorded a site.
// Placement only: the marker says the point comes from the company profile.
export const PROFILE_ORIGIN_AT: Record<string, LonLat> = {
  Vietnam: [107.6, 16.1],
  Singapore: [103.85, 1.29],
  Indonesia: [106.83, -6.18],
  Thailand: [100.5, 13.76],
};

export const PROFILE_HOME_ID: Record<string, string> = {
  Vietnam: "704",
  Singapore: "702",
  Indonesia: "360",
  Thailand: "764",
};

type RouteStart = { at: LonLat; approximate: boolean };

export function routeStart(
  sites: MapSite[],
  companyOrigin: string,
): RouteStart | null {
  const site = sites.find((s) => s.isRouteOrigin);
  if (site) return { at: lonLat(site.location), approximate: false };
  const at = PROFILE_ORIGIN_AT[companyOrigin];
  return at ? { at, approximate: true } : null;
}

// Bends a route toward the top of the map so arcs read as journeys, not borders.
export function arcPath([x1, y1]: [number, number], [x2, y2]: [number, number]) {
  const dx = x2 - x1,
    dy = y2 - y1,
    length = Math.hypot(dx, dy) || 1;
  let nx = -dy / length,
    ny = dx / length;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const bend = Math.min(length * 0.22, 90);
  return `M${x1},${y1} Q${(x1 + x2) / 2 + nx * bend},${(y1 + y2) / 2 + ny * bend} ${x2},${y2}`;
}

export function floodView(flood: SatelliteObservation, checkRadiusKm: number): View {
  const reach = flood.radiusKm + checkRadiusKm + 8;
  const { longitude: lon, latitude: lat } = flood.center;
  const dLat = reach / 110.57,
    dLon = reach / (111.32 * Math.cos((lat * Math.PI) / 180));
  return {
    id: "focus",
    label: `Flood · ${flood.place.split(",").pop()!.trim()}`,
    bounds: [
      [lon - dLon, lat - dLat],
      [lon + dLon, lat + dLat],
    ],
  };
}

export function checkInDraft(
  flood: SatelliteObservation,
  group: SupplierGroup,
  km: number,
  signature: string,
) {
  const where =
    km === 0 ? "where your site is" : `about ${km} km from your site`;
  const upcoming = [...group.rows]
    .sort(byShipDate)
    .slice(0, 4)
    .map(
      (r) =>
        `- ${r.order.id} (${r.order.product}), planned to ship ${date(r.order.shipDate)}`,
    );
  return `Hello ${group.name},

${flood.isSample ? "A sample flood scenario dated" : "Satellite flood mapping from"} ${date(flood.observedOn)} shows ${flood.confidence === "high" ? "standing water" : "possible flooding"} around ${flood.place}, ${where}. ${flood.isSample ? "This is a fictional exercise, not evidence of an actual flood at your site." : "We cannot confirm from this observation whether you are affected, so we wanted to check in."}

Could you let us know:
- whether your site, stock or road access has been affected;
- whether these orders can still ship as planned:
${upcoming.join("\n") || "- (no open orders right now)"}

Thank you,
${signature}`;
}
