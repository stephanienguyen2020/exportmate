import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  geoArea,
  geoCircle,
  geoContains,
  geoGraticule10,
  geoMercator,
  geoNaturalEarth1,
  geoPath,
  type GeoProjection,
} from "d3-geo";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import type { Feature, FeatureCollection, Geometry, Polygon } from "geojson";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  CircleHelp,
  Copy,
  Layers,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Route,
  Satellite,
  ShieldCheck,
  Trash2,
  Waves,
  X,
} from "lucide-react";
import world110Url from "world-atlas/countries-110m.json?url";
import world50Url from "world-atlas/countries-50m.json?url";
import { date, money, type Order } from "./data";
import {
  api,
  asOrder,
  type GeoPoint,
  type MapMarket,
  type MapOrder,
  type MapSite,
  type MapSupplier,
  type MarketComparison,
  type RequirementCheck,
  type SatelliteObservation,
  type SiteInput,
  type SupplierInput,
  type TradeMap,
} from "./api";
import { errorMessage } from "./auth";
import { useImpacts, type Impact } from "../ai/news/NewsWatch";
import { RegulationCitation } from "./Regulations";
import TradeMapGlobe, {
  type GlobePoint,
  type GlobeRoute,
} from "./TradeMapGlobe";
import "./trade-map.css";

// Map geometry is presentation: the data (places, documents, checklists,
// observations) comes from the backend's /trade-map, stored in Postgres.
const W = 960;
const H = 480;
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

type LonLat = [number, number];
type LabelSide = "left" | "right" | "top" | "bottom";
type Tone = "red" | "amber" | "green";
type ViewId = "world" | "production" | "europe" | "americas" | "asia" | "focus";
type View = { id: ViewId; label: string; bounds?: [LonLat, LonLat] };
// Camera presets for market regions. The production view is fitted to the
// company's own sites and suppliers instead.
const MARKET_VIEWS: View[] = [
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
const WORLD_VIEW: View = { id: "world", label: "World" };

type Selection =
  | { kind: "market"; code: string }
  | { kind: "supplier"; name: string }
  | { kind: "site"; id: string }
  | { kind: "flood"; id: string };
type ScenarioMode = "market" | "date" | "route";
type Scenario = { orderId: string; mode: ScenarioMode; target: string | null };
type Row = {
  order: Order;
  placement: MapOrder["placement"];
  checks: RequirementCheck[];
  gaps: RequirementCheck[];
};
type SupplierGroup = {
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
type FloodEntry = {
  flood: SatelliteObservation;
  suppliers: { group: SupplierGroup; km: number }[];
  sites: { site: MapSite; km: number }[];
};
type MarketSummary = { market: MapMarket; rows: Row[]; tone: Tone };
// An open supplier or site form. `group`/`site` null adds a new one.
type Editing =
  | { type: "supplier"; group: SupplierGroup | null; name?: string }
  | { type: "site"; site: MapSite | null };
// The location being entered. `picked` counts map clicks, so a form can tell a
// click (which also suggests the country) from typed coordinates.
type Pin = { at: LonLat; country: string | null; picked: number };
type Marker = {
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
type Focus = {
  markets: Set<string>;
  suppliers: Set<string>;
  sites: Set<string>;
  floods: Set<string>;
};

export type TradeMapProps = {
  live: boolean;
  editable: boolean;
  focus: string;
  toneOf: (order: Order) => Tone;
  renderStatus: (order: Order) => React.ReactNode;
  onNavigate: (path: string) => void;
  signature: string;
  companyOrigin: string;
};

type Atlas = Feature<Geometry, { name: string }>[];
const atlasCache: Partial<Record<"110m" | "50m", Promise<Atlas>>> = {};
function loadAtlas(detail: "110m" | "50m") {
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

function projectionFor(view: View): GeoProjection {
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
const worst = (tones: Tone[]): Tone =>
  tones.reduce<Tone>((a, b) => (TONE_RANK[b] < TONE_RANK[a] ? b : a), "green");
// Same rule as the backend's supplier_name_key.
const supplierKey = (name: string) =>
  name.trim().split(/\s+/).join(" ").toLowerCase();
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const pct = (value: number, total: number) => `${(value / total) * 100}%`;
const byShipDate = (a: Row, b: Row) =>
  a.order.shipDate.localeCompare(b.order.shipDate);
const productKey = (s: string) =>
  s.toLowerCase().replace(/[·,]/g, " ").replace(/\s+/g, " ").trim();
const lonLat = (p: GeoPoint): LonLat => [p.longitude, p.latitude];
const isGap = (c: RequirementCheck) =>
  c.status === "missing" || c.status === "mismatch";
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const marketTerms = (market: MapMarket) =>
  market.searchTerms.length
    ? new RegExp(
        `(?<!\\w)(${market.searchTerms.map(escapeRegExp).join("|")})(?!\\w)`,
      )
    : null;

// GeoJSON (RFC 7946) winds outer rings counter-clockwise; d3-geo expects the
// opposite and would otherwise fill the whole globe except the shape.
function forD3(polygon: Polygon): Polygon {
  return geoArea(polygon) > 2 * Math.PI
    ? {
        ...polygon,
        coordinates: polygon.coordinates.map((ring) => [...ring].reverse()),
      }
    : polygon;
}

// A view around the company's own places, at least a few degrees across.
function productionView(points: LonLat[]): View | null {
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
const PROFILE_ORIGIN_AT: Record<string, LonLat> = {
  Vietnam: [107.6, 16.1],
  Singapore: [103.85, 1.29],
  Indonesia: [106.83, -6.18],
  Thailand: [100.5, 13.76],
};
const PROFILE_HOME_ID: Record<string, string> = {
  Vietnam: "704",
  Singapore: "702",
  Indonesia: "360",
  Thailand: "764",
};
type RouteStart = { at: LonLat; approximate: boolean };
function routeStart(
  sites: MapSite[],
  companyOrigin: string,
): RouteStart | null {
  const site = sites.find((s) => s.isRouteOrigin);
  if (site) return { at: lonLat(site.location), approximate: false };
  const at = PROFILE_ORIGIN_AT[companyOrigin];
  return at ? { at, approximate: true } : null;
}

// Bends a route toward the top of the map so arcs read as journeys, not borders.
function arcPath([x1, y1]: [number, number], [x2, y2]: [number, number]) {
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

function floodView(flood: SatelliteObservation, checkRadiusKm: number): View {
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

function checkInDraft(
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

export default function TradeMapPage(props: TradeMapProps) {
  const [data, setData] = useState<TradeMap | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!props.live) return;
    const controller = new AbortController();
    setError("");
    api
      .tradeMap(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [props.live, attempt]);

  const heading = (
    <section className="page-heading">
      <div>
        <span className="eyebrow">YOUR TRADE, ON THE MAP.</span>
        <h1>Trade map.</h1>
        <p>Suppliers, sites, markets and the orders between them.</p>
      </div>
    </section>
  );
  if (!props.live)
    return (
      <>
        {heading}
        <section className="panel tm-gate">
          <ShieldCheck size={28} />
          <h2>Your map lives in your company workspace.</h2>
          <p>
            The trade map reads your orders, suppliers, sites, supplier
            documents and market checklists from your company's database. The
            sample demo keeps its data in this browser only, so there is nothing
            to map yet.
          </p>
          <a className="btn" href="#/login">
            Sign in to your company workspace
            <ArrowUpRight size={16} />
          </a>
        </section>
      </>
    );
  if (error)
    return (
      <>
        {heading}
        <section className="panel" role="alert">
          <h2>Couldn’t load your trade map.</h2>
          <p>{error}</p>
          <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </section>
      </>
    );
  if (!data)
    return (
      <>
        {heading}
        <section className="panel" role="status">
          <Loader2 size={20} /> Loading your trade map…
        </section>
      </>
    );
  return (
    <TradeMapView
      {...props}
      data={data}
      onReload={async () => setData(await api.tradeMap())}
    />
  );
}

function TradeMapView({
  data,
  onReload,
  editable,
  focus,
  toneOf,
  renderStatus,
  onNavigate,
  signature,
  companyOrigin,
}: TradeMapProps & { data: TradeMap; onReload: () => Promise<void> }) {
  const markets = data.markets;
  const marketByCode = useMemo(
    () => new Map(markets.map((m) => [m.code, m])),
    [markets],
  );
  const rows = useMemo<Row[]>(
    () =>
      data.orders.map((o) => ({
        order: asOrder(o.order),
        placement: o.placement,
        checks: o.checks,
        gaps: o.checks.filter(isGap),
      })),
    [data.orders],
  );
  const suppliers = useMemo<SupplierGroup[]>(() => {
    const byId = new Map(rows.map((r) => [r.order.id, r]));
    return data.suppliers
      .map((s) => ({
        key: supplierKey(s.name),
        id: s.id,
        name: s.name,
        country: s.country,
        place: s.place,
        at: s.location ? lonLat(s.location) : null,
        supplies: s.supplies,
        contactName: s.contactName ?? null,
        contactEmail: s.contactEmail ?? null,
        documents: s.documents,
        rows: s.orderIds.map((id) => byId.get(id)!).filter(Boolean),
      }))
      .sort((a, b) => b.rows.length - a.rows.length);
  }, [data.suppliers, rows]);
  const supplierByKey = useMemo(
    () => new Map(suppliers.map((s) => [s.key, s])),
    [suppliers],
  );
  const summaries = useMemo<MarketSummary[]>(
    () =>
      markets
        .map((market) => {
          const items = rows.filter((r) => r.placement.market === market.code);
          return {
            market,
            rows: items,
            tone: worst(items.map((r) => toneOf(r.order))),
          };
        })
        .filter((m) => m.rows.length),
    [markets, rows, toneOf],
  );
  const floods = useMemo<FloodEntry[]>(
    () =>
      data.observations.map((flood) => ({
        flood,
        suppliers: flood.nearby
          .filter((n) => n.type === "supplier")
          .map((n) => ({
            group: supplierByKey.get(supplierKey(n.ref))!,
            km: n.distanceKm,
          }))
          .filter((n) => n.group),
        sites: flood.nearby
          .filter((n) => n.type === "site")
          .map((n) => ({
            site: data.sites.find((s) => s.key === n.ref)!,
            km: n.distanceKm,
          }))
          .filter((n) => n.site),
      })),
    [data.observations, data.sites, supplierByKey],
  );
  const production = useMemo(
    () =>
      productionView([
        ...data.sites.map((s) => lonLat(s.location)),
        ...suppliers.flatMap((s) => (s.at ? [s.at] : [])),
      ]),
    [data.sites, suppliers],
  );
  const views = [
    WORLD_VIEW,
    ...(production ? [production] : []),
    ...MARKET_VIEWS,
  ];
  const viewById = (id: ViewId) => views.find((v) => v.id === id) ?? WORLD_VIEW;
  const unplaced = rows.filter((r) => !r.placement.location);
  const unlocated = suppliers.filter((s) => !s.at);
  const check = data.checkRadiusKm;

  const initial = useMemo(() => {
    const [kind, ...rest] = focus.split("/");
    let value = rest.join("/");
    try {
      value = decodeURIComponent(value);
    } catch {
      return {};
    }
    if (kind === "order" && rows.some((r) => r.order.id === value))
      return {
        scenario: { orderId: value, mode: "market", target: null } as Scenario,
      };
    if (kind === "market" && marketByCode.has(value))
      return { selection: { kind: "market", code: value } as Selection };
    if (kind === "supplier" && value)
      return {
        selection: { kind: "supplier", name: value } as Selection,
        view: production ?? WORLD_VIEW,
      };
    return {};
  }, []);
  const [view, setView] = useState<View>(initial.view ?? WORLD_VIEW);
  const [selection, setSelection] = useState<Selection | null>(
    initial.selection ?? null,
  );
  const [scenario, setScenario] = useState<Scenario | null>(
    initial.scenario ?? null,
  );
  const [comparisonResult, setComparisonResult] = useState<{
    key: string;
    comparison: MarketComparison;
  } | null>(null);
  const comparisonKey = scenario?.target
    ? JSON.stringify([scenario.orderId, scenario.mode, scenario.target])
    : "";
  const routeComparison =
    comparisonResult?.key === comparisonKey &&
    comparisonResult.comparison.kind === "route"
      ? comparisonResult.comparison
      : undefined;
  const [showRoutes, setShowRoutes] = useState(true);
  const [showSatellite, setShowSatellite] = useState(true);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pin, setPin] = useState<Pin | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { impacts } = useImpacts();

  const scenarioRow = scenario
    ? rows.find((r) => r.order.id === scenario.orderId)
    : undefined;

  const reveal = () => {
    if (matchMedia("(max-width: 1200px)").matches)
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const select = (next: Selection | null, nextView?: View) => {
    setScenario(null);
    setEditing(null);
    setPin(null);
    setSelection(next);
    if (nextView) setView(nextView);
    if (next) reveal();
  };
  const selectFlood = (flood: SatelliteObservation) =>
    select({ kind: "flood", id: flood.id }, floodView(flood, check));
  const startScenario = (orderId: string) => {
    setSelection(null);
    setEditing(null);
    setPin(null);
    setScenario({ orderId, mode: "market", target: null });
    setView(WORLD_VIEW);
    reveal();
  };
  const chooseMarket = (code: string) => {
    if (scenario) {
      if (scenario.mode === "market" && scenarioRow?.placement.market !== code)
        setScenario({ ...scenario, target: code });
      return;
    }
    select({ kind: "market", code });
  };
  const originKey = data.sites.find((s) => s.isRouteOrigin)?.key;
  // Forms place things on a 2D view of the company's own area.
  const startEditing = (next: Editing) => {
    const at =
      next.type === "supplier"
        ? (next.group?.at ?? null)
        : next.site
          ? lonLat(next.site.location)
          : null;
    const profileAt = PROFILE_ORIGIN_AT[companyOrigin];
    const area =
      production ??
      (at || profileAt
        ? { ...productionView([at ?? profileAt])!, id: "focus" as const, label: "Place" }
        : viewById("asia"));
    setScenario(null);
    setEditing(next);
    setPin(at ? { at, country: null, picked: 0 } : null);
    if (view.id !== "production" && view.id !== "focus") setView(area);
    reveal();
  };
  const onPick = (at: LonLat, countryId: string | null) =>
    setPin((current) => ({
      at,
      country:
        data.countries.find((c) => c.numericCode === countryId)?.code ?? null,
      picked: (current?.picked ?? 0) + 1,
    }));
  const finishEditing = async (next: Selection | null) => {
    await onReload();
    setEditing(null);
    setPin(null);
    setSelection(next);
  };

  // What the current selection touches; everything else is dimmed.
  const focusSet = useMemo<Focus | null>(() => {
    const set: Focus = {
      markets: new Set(),
      suppliers: new Set(),
      sites: new Set(originKey ? [originKey] : []),
      floods: new Set(),
    };
    if (scenario) {
      if (!scenarioRow) return null;
      if (scenarioRow.placement.market)
        set.markets.add(scenarioRow.placement.market);
      if (scenario.mode === "market" && scenario.target)
        set.markets.add(scenario.target);
      set.suppliers.add(supplierKey(scenarioRow.order.supplier));
      return set;
    }
    if (!selection) return null;
    if (selection.kind === "market") {
      set.markets.add(selection.code);
      rows
        .filter((r) => r.placement.market === selection.code)
        .forEach((r) => set.suppliers.add(supplierKey(r.order.supplier)));
    } else if (selection.kind === "supplier") {
      const key = supplierKey(selection.name);
      set.suppliers.add(key);
      supplierByKey
        .get(key)
        ?.rows.forEach(
          (r) => r.placement.market && set.markets.add(r.placement.market),
        );
      floods
        .filter((f) => f.suppliers.some((s) => s.group.key === key))
        .forEach((f) => set.floods.add(f.flood.id));
    } else if (selection.kind === "site") {
      set.sites.add(selection.id);
      floods
        .filter((f) => f.sites.some((s) => s.site.key === selection.id))
        .forEach((f) => set.floods.add(f.flood.id));
    } else {
      set.floods.add(selection.id);
      const near = floods.find((f) => f.flood.id === selection.id);
      near?.suppliers.forEach((s) => set.suppliers.add(s.group.key));
      near?.sites.forEach((s) => set.sites.add(s.site.key));
    }
    return set;
  }, [
    selection,
    scenario,
    scenarioRow,
    rows,
    supplierByKey,
    floods,
    originKey,
  ]);

  const isSelected = (m: Marker) =>
    (selection?.kind === "market" && m.market === selection.code) ||
    (selection?.kind === "supplier" &&
      m.supplier === supplierKey(selection.name)) ||
    (selection?.kind === "site" && m.siteId === selection.id) ||
    (selection?.kind === "flood" && m.floodId === selection.id) ||
    (!!scenario &&
      scenario.mode === "market" &&
      !!m.market &&
      (m.market === scenario.target ||
        m.market === scenarioRow?.placement.market));
  const isRelated = (m: Marker) =>
    !focusSet ||
    m.kind === "origin" ||
    (!!m.market && focusSet.markets.has(m.market)) ||
    (!!m.supplier && focusSet.suppliers.has(m.supplier)) ||
    (!!m.siteId && focusSet.sites.has(m.siteId)) ||
    (!!m.floodId && focusSet.floods.has(m.floodId));

  const onMarker = (m: Marker) => {
    if (m.kind === "origin") setView(viewById("production"));
    else if (m.market) chooseMarket(m.market);
    else if (m.supplier) {
      const group = supplierByKey.get(m.supplier);
      if (group) select({ kind: "supplier", name: group.name });
    } else if (m.siteId) select({ kind: "site", id: m.siteId });
    else if (m.floodId) {
      const flood = data.observations.find((f) => f.id === m.floodId);
      if (flood) selectFlood(flood);
    }
  };
  const openOrder = (id: string) =>
    onNavigate("orders/" + encodeURIComponent(id));
  const allSample = data.observations.every((o) => o.isSample);

  const panel = editing ? (
    editing.type === "supplier" ? (
      <SupplierForm
        key={editing.group?.key ?? "new"}
        group={editing.group}
        name={editing.name}
        documentKinds={data.documentKinds}
        countries={data.countries}
        pin={pin}
        onPin={setPin}
        onSaved={(name) => finishEditing({ kind: "supplier", name })}
        onDeleted={() => finishEditing(null)}
        onCancel={() => {
          setEditing(null);
          setPin(null);
        }}
      />
    ) : (
      <SiteForm
        key={editing.site?.id ?? "new"}
        site={editing.site}
        originName={data.sites.find((s) => s.isRouteOrigin)?.name ?? null}
        countries={data.countries}
        pin={pin}
        onPin={setPin}
        onSaved={(key) => finishEditing({ kind: "site", id: key })}
        onDeleted={() => finishEditing(null)}
        onCancel={() => {
          setEditing(null);
          setPin(null);
        }}
      />
    )
  ) : scenario ? (
    <ScenarioPanel
      rows={rows}
      markets={markets}
      scenario={scenario}
      renderStatus={renderStatus}
      onChange={setScenario}
      onComparison={setComparisonResult}
      onClose={() => setScenario(null)}
      onOpenOrder={openOrder}
    />
  ) : selection?.kind === "market" && marketByCode.has(selection.code) ? (
    <MarketPanel
      market={marketByCode.get(selection.code)!}
      rows={rows.filter((r) => r.placement.market === selection.code)}
      impacts={impacts || []}
      toneOf={toneOf}
      renderStatus={renderStatus}
      onBack={() => select(null)}
      onOpenOrder={openOrder}
      onCompare={startScenario}
      onSupplier={(name) => select({ kind: "supplier", name })}
      onNews={() => onNavigate("news")}
    />
  ) : selection?.kind === "supplier" ? (
    <SupplierPanel
      group={
        supplierByKey.get(supplierKey(selection.name)) ?? {
          key: supplierKey(selection.name),
          id: null,
          name: selection.name,
          country: null,
          place: null,
          at: null,
          supplies: null,
          contactName: null,
          contactEmail: null,
          documents: null,
          rows: [],
        }
      }
      documentKinds={data.documentKinds}
      floods={floods}
      marketByCode={marketByCode}
      renderStatus={renderStatus}
      onBack={() => select(null)}
      onOpenOrder={openOrder}
      onCompare={startScenario}
      onMarket={(code) => select({ kind: "market", code })}
      onFlood={selectFlood}
      onEdit={
        editable
          ? (group) => startEditing({ type: "supplier", group })
          : undefined
      }
    />
  ) : selection?.kind === "site" &&
    data.sites.some((s) => s.key === selection.id) ? (
    <SitePanel
      site={data.sites.find((s) => s.key === selection.id)!}
      suppliers={suppliers}
      floods={floods}
      checkRadiusKm={check}
      onBack={() => select(null)}
      onSupplier={(name) => select({ kind: "supplier", name })}
      onFlood={selectFlood}
      onEdit={
        editable ? (site) => startEditing({ type: "site", site }) : undefined
      }
    />
  ) : selection?.kind === "flood" &&
    floods.some((f) => f.flood.id === selection.id) ? (
    <FloodPanel
      entry={floods.find((f) => f.flood.id === selection.id)!}
      checkRadiusKm={check}
      signature={signature}
      renderStatus={renderStatus}
      onBack={() => select(null)}
      onOpenOrder={openOrder}
      onSupplier={(name) => select({ kind: "supplier", name })}
    />
  ) : (
    <OverviewPanel
      orderCount={rows.length}
      markets={summaries}
      suppliers={suppliers}
      sites={data.sites}
      floods={showSatellite ? floods : []}
      unplaced={unplaced}
      unlocated={unlocated}
      onMarket={(code) => select({ kind: "market", code })}
      onSupplier={(name) =>
        select({ kind: "supplier", name }, production ?? undefined)
      }
      onSite={(id) => select({ kind: "site", id }, production ?? undefined)}
      onFlood={selectFlood}
      onImport={() => onNavigate("data")}
      onAddSupplier={
        editable
          ? (group) =>
              startEditing({
                type: "supplier",
                group: group?.id ? group : null,
                name: group?.name,
              })
          : undefined
      }
      onAddSite={
        editable
          ? () => startEditing({ type: "site", site: null })
          : undefined
      }
    />
  );

  return (
    <>
      <section className="page-heading">
        <div>
          <span className="eyebrow">YOUR TRADE, ON THE MAP.</span>
          <h1>Trade map.</h1>
          <p>Suppliers, sites, markets and the orders between them.</p>
        </div>
        <button
          className={"btn " + (scenario ? "secondary" : "")}
          onClick={() =>
            scenario
              ? setScenario(null)
              : startScenario(
                  (rows.find((r) => r.order.risk) ?? rows[0])?.order.id ?? "",
                )
          }
          disabled={!rows.length}
        >
          <ArrowLeftRight size={16} />
          {scenario ? "Close comparison" : "Compare a market"}
        </button>
      </section>
      <div className="notice tm-notice">
        <ShieldCheck size={18} />
        Orders, suppliers, sites and documents come from your company workspace.
        Market checklists are illustrative, not legal guidance
        {data.observations.length
          ? allSample
            ? "; satellite observations are samples, not a live feed."
            : "; observations marked sample are not a live feed."
          : "."}
      </div>
      <div className="tm-layout">
        <div className="tm-stage">
          <div className="tm-toolbar">
            <div className="tabs tm-views" role="tablist" aria-label="Map area">
              {views.map((v) => (
                <button
                  key={v.id}
                  role="tab"
                  aria-selected={view.id === v.id}
                  className={view.id === v.id ? "selected" : ""}
                  onClick={() => setView(v)}
                >
                  {v.label}
                </button>
              ))}
              {view.id === "focus" && (
                <button role="tab" aria-selected className="selected">
                  {view.label}
                </button>
              )}
            </div>
            <div className="tm-layers" aria-label="Map layers">
              <Layers size={14} aria-hidden="true" />
              <button
                className="tm-toggle"
                aria-pressed={showRoutes}
                onClick={() => setShowRoutes(!showRoutes)}
              >
                <Route size={13} />
                Routes
              </button>
              <button
                className="tm-toggle"
                aria-pressed={showSatellite}
                onClick={() => setShowSatellite(!showSatellite)}
              >
                <Satellite size={13} />
                Satellite
              </button>
            </div>
          </div>
          <MapCanvas
            view={view}
            data={data}
            rows={rows}
            summaries={summaries}
            suppliers={suppliers}
            marketByCode={marketByCode}
            scenario={scenario}
            scenarioRow={scenarioRow}
            routeComparison={routeComparison}
            selectionMarket={
              selection?.kind === "market" ? selection.code : null
            }
            showRoutes={showRoutes}
            showSatellite={showSatellite}
            companyOrigin={companyOrigin}
            toneOf={toneOf}
            isSelected={isSelected}
            isRelated={isRelated}
            onMarker={onMarker}
            picking={!!editing}
            pin={pin?.at ?? null}
            onPick={onPick}
          />
          <ul className="tm-legend" aria-label="Map legend">
            <li>
              <i className="tm-key market tone-red" /> Action needed
            </li>
            <li>
              <i className="tm-key market tone-amber" /> Awaiting analysis
            </li>
            <li>
              <i className="tm-key market tone-green" /> In the clear
            </li>
            <li>
              <i className="tm-key supplier" /> Supplier
            </li>
            <li>
              <i className="tm-key site" /> Your site
            </li>
            {showSatellite && data.observations.length > 0 && (
              <li>
                <i className="tm-key flood" /> Flood observations
                {allSample ? " · sample" : ""} · {check} km proximity check
              </li>
            )}
            {scenario?.mode === "market" && (
              <li>
                <i className="tm-key alt" /> Market being compared
              </li>
            )}
            {showRoutes && !!routeComparison?.routePoints?.length && (
              <li>
                <i className="tm-key alt" /> Proposed route
              </li>
            )}
          </ul>
        </div>
        <div className="tm-panel" ref={panelRef} aria-live="polite">
          {panel}
        </div>
      </div>
    </>
  );
}

function MapCanvas({
  view,
  data,
  rows,
  summaries,
  suppliers,
  marketByCode,
  scenario,
  scenarioRow,
  routeComparison,
  selectionMarket,
  showRoutes,
  showSatellite,
  companyOrigin,
  toneOf,
  isSelected,
  isRelated,
  onMarker,
  picking,
  pin,
  onPick,
}: {
  view: View;
  data: TradeMap;
  rows: Row[];
  summaries: MarketSummary[];
  suppliers: SupplierGroup[];
  marketByCode: Map<string, MapMarket>;
  scenario: Scenario | null;
  scenarioRow?: Row;
  routeComparison?: MarketComparison;
  selectionMarket: string | null;
  showRoutes: boolean;
  showSatellite: boolean;
  companyOrigin: string;
  toneOf: (order: Order) => Tone;
  isSelected: (m: Marker) => boolean;
  isRelated: (m: Marker) => boolean;
  onMarker: (m: Marker) => void;
  picking: boolean;
  pin: LonLat | null;
  onPick: (at: LonLat, countryId: string | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(W);
  const [globe, setGlobe] = useState(true);
  const [globeUnavailable, setGlobeUnavailable] = useState(false);
  const [atlas, setAtlas] = useState<{ "110m"?: Atlas; "50m"?: Atlas }>({});
  const [atlasError, setAtlasError] = useState(false);
  const detailed = view.id !== "world";
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width || W),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [view.id, globe, globeUnavailable]);
  useEffect(() => {
    let active = true;
    const detail = detailed ? "50m" : "110m";
    if (atlas[detail]) return;
    // Show the light outlines while the detailed ones load.
    for (const d of detailed ? (["110m", "50m"] as const) : (["110m"] as const))
      loadAtlas(d)
        .then(
          (countries) => active && setAtlas((a) => ({ ...a, [d]: countries })),
        )
        .catch(() => active && setAtlasError(true));
    return () => {
      active = false;
    };
  }, [detailed]);

  const projection = useMemo(() => projectionFor(view), [view]);
  const path = useMemo(() => geoPath(projection), [projection]);
  const countries = (detailed && atlas["50m"]) || atlas["110m"] || [];
  const countryPaths = useMemo(
    () => countries.map((f) => ({ id: String(f.id), d: path(f) || "" })),
    [countries, path],
  );
  const graticule = useMemo(
    () => (view.bounds ? "" : path(geoGraticule10()) || ""),
    [path, view.bounds],
  );

  const project = (at: LonLat) => {
    const point = projection(at);
    return point &&
      point[0] > -6 &&
      point[0] < W + 6 &&
      point[1] > -6 &&
      point[1] < H + 6
      ? (point as [number, number])
      : null;
  };
  // Markers keep a constant on-screen size, so overlap depends on real width.
  const scale = width / W;
  const merge = 16 / scale;

  const countriesOf = (code: string | null | undefined) =>
    (code && marketByCode.get(code)?.countryIds) || [];
  const home = new Set(data.homeCountryIds);
  const tinted = new Set(summaries.flatMap((m) => m.market.countryIds));
  const active = new Set([
    ...countriesOf(selectionMarket),
    ...countriesOf(scenarioRow?.placement.market),
  ]);
  const marketTarget = scenario?.mode === "market" ? scenario.target : null;
  const target = new Set(countriesOf(marketTarget));

  const originSite = data.sites.find((s) => s.isRouteOrigin);
  const profileStart = routeStart(data.sites, companyOrigin);
  const routePoints = routeComparison?.routePoints ?? [];
  const start =
    profileStart && routePoints.length
      ? { ...profileStart, at: lonLat(routePoints[0]) }
      : profileStart;
  const routeLabel =
    routePoints.length > 1
      ? `${start?.approximate ? companyOrigin : "Production"} → ${routePoints.length > 2 ? `${routeComparison!.viaName} → ` : ""}${scenarioRow?.placement.city ?? "Destination"}`
      : null;
  if (start?.approximate && PROFILE_HOME_ID[companyOrigin])
    home.add(PROFILE_HOME_ID[companyOrigin]);
  const markers: Marker[] = [];
  const origin = start ? project(start.at) : null;
  const showOrigin = view.id === "world" || view.id === "asia";
  if (showOrigin && start && origin)
    markers.push({
      key: "origin",
      kind: "origin",
      x: origin[0],
      y: origin[1],
      label: start.approximate ? companyOrigin : "Production",
      aria: start.approximate
        ? `Approximate start in ${companyOrigin}, from your company profile. No production site is recorded yet.`
        : "Your production sites and suppliers. Zoom in.",
      tone: "neutral",
      count: rows.length,
      side: "left",
      origin: true,
    });
  if (view.id === "world") {
    for (const { market, rows: items, tone } of summaries) {
      const at = project(lonLat(market.hub));
      if (at)
        markers.push({
          key: "market-" + market.code,
          kind: "market",
          x: at[0],
          y: at[1],
          label: market.shortName,
          aria: `${market.name}: ${plural(items.length, "order")}`,
          tone,
          count: items.length,
          side: "right",
          market: market.code,
        });
    }
  } else if (
    view.id === "europe" ||
    view.id === "americas" ||
    view.id === "asia"
  ) {
    const ports = new Map<string, Marker>();
    for (const row of rows) {
      const { location, market, city, country, approximate } = row.placement;
      if (!location || !market) continue;
      const at = project(lonLat(location));
      if (!at) continue;
      const key = `${city.toLowerCase()}|${country}`;
      const existing = ports.get(key);
      if (existing) {
        existing.count++;
        existing.tone = worst([existing.tone as Tone, toneOf(row.order)]);
      } else
        ports.set(key, {
          key: "port-" + key,
          kind: "port",
          x: at[0],
          y: at[1],
          label: city + (approximate ? " (approx.)" : ""),
          aria: "",
          tone: toneOf(row.order),
          count: 1,
          side: "right",
          market,
        });
    }
    // Merge ports that would overlap at the current width (Los Angeles · Long Beach).
    const clusters: Marker[] = [];
    for (const port of [...ports.values()].sort((a, b) => b.count - a.count)) {
      const near = clusters.find(
        (c) =>
          c.market === port.market &&
          Math.hypot(c.x - port.x, c.y - port.y) < merge,
      );
      if (near) {
        near.label += " · " + port.label;
        near.count += port.count;
        near.tone = worst([near.tone as Tone, port.tone as Tone]);
      } else clusters.push({ ...port });
    }
    for (const c of clusters) {
      c.aria = `${c.label}, ${marketByCode.get(c.market!)?.name}: ${plural(c.count, "order")}`;
      markers.push(c);
    }
  }
  // While comparing, every market is a possible destination.
  if (scenario && view.id !== "production" && view.id !== "focus")
    for (const market of marketByCode.values()) {
      if (
        view.id === "world" &&
        summaries.some((m) => m.market.code === market.code)
      )
        continue;
      if (view.id !== "world" && markers.some((m) => m.market === market.code))
        continue;
      const at = project(lonLat(market.hub));
      if (at)
        markers.push({
          key: "option-" + market.code,
          kind: "market",
          x: at[0],
          y: at[1],
          label: market.shortName,
          aria: `Compare with ${market.name}`,
          tone: "neutral",
          count: 0,
          side: "right",
          market: market.code,
        });
    }
  if (view.id === "production" || view.id === "focus") {
    for (const group of suppliers) {
      const at = group.at && project(group.at);
      if (at)
        markers.push({
          key: "supplier-" + group.key,
          kind: "supplier",
          x: at[0],
          y: at[1],
          label: group.name,
          aria: `Supplier ${group.name}, ${group.place ?? ""}: ${plural(group.rows.length, "order")}`,
          tone: group.rows.length
            ? worst(group.rows.map((r) => toneOf(r.order)))
            : "neutral",
          count: group.rows.length,
          side: "right",
          supplier: group.key,
        });
    }
    for (const site of data.sites) {
      const at = project(lonLat(site.location));
      if (at)
        markers.push({
          key: "site-" + site.key,
          kind: "site",
          x: at[0],
          y: at[1],
          label: site.shortName,
          aria: `${site.name}, ${site.place}`,
          tone: "neutral",
          count: 0,
          side: "left",
          siteId: site.key,
          origin: site.key === originSite?.key,
        });
    }
    if (showSatellite)
      for (const flood of data.observations) {
        const at = project(lonLat(flood.center));
        if (at)
          markers.push({
            key: "flood-" + flood.id,
            kind: "flood",
            x: at[0],
            y: at[1],
            label: `Flood · ${date(flood.observedOn)}`,
            aria: `${flood.isSample ? "Sample satellite observation" : "Satellite observation"}: ${flood.title}, ${date(flood.observedOn)}`,
            tone: "water",
            count: 0,
            side: "top",
            floodId: flood.id,
          });
      }
  }

  spread(markers, scale);
  const labelSides = placeLabels(
    markers,
    scale,
    width,
    (m) =>
      (isSelected(m) ? -10000 : 0) +
      (isRelated(m) ? 0 : 1000) +
      (m.origin ? KIND_RANK.origin : KIND_RANK[m.kind]) * 100 +
      (m.count ? -Math.min(m.count, 99) : 50),
  );

  const arcs: {
    key: string;
    d: string;
    tone: Tone | "neutral";
    width: number;
    dim: boolean;
    dashed?: boolean;
  }[] = [];
  if (showRoutes && origin && showOrigin)
    for (const m of markers)
      if ((m.kind === "market" || m.kind === "port") && m.count > 0)
        arcs.push({
          key: "arc-" + m.key,
          d: arcPath(origin, [m.x, m.y]),
          tone: m.tone as Tone,
          width: 2.2 + Math.sqrt(m.count),
          dim: routePoints.length > 1 || !isRelated(m),
          dashed: start?.approximate,
        });
  if (showRoutes && (view.id === "production" || view.id === "focus")) {
    const hub = markers.find((m) => m.origin);
    if (hub)
      for (const m of markers)
        if (m.kind === "supplier")
          arcs.push({
            key: "source-" + m.key,
            d: `M${m.x},${m.y} L${hub.x},${hub.y}`,
            tone: "neutral",
            width: 1,
            dim: !isRelated(m),
            dashed: true,
          });
  }
  let scenarioArcs: { key: string; d: string; kind: "current" | "target" }[] =
    [];
  if (
    showRoutes &&
    scenario?.mode === "market" &&
    scenarioRow &&
    origin &&
    showOrigin
  ) {
    const current = markers.find(
      (m) =>
        !!scenarioRow.placement.market &&
        m.market === scenarioRow.placement.market,
    );
    const next = marketTarget && markers.find((m) => m.market === marketTarget);
    scenarioArcs = [
      current && {
        key: "current",
        d: arcPath(origin, [current.x, current.y]),
        kind: "current" as const,
      },
      next && {
        key: "target",
        d: arcPath(origin, [next.x, next.y]),
        kind: "target" as const,
      },
    ].filter(Boolean) as typeof scenarioArcs;
  }

  if (showRoutes && routePoints.length > 1) {
    for (let i = 1; i < routePoints.length; i++) {
      const from = project(lonLat(routePoints[i - 1]));
      const to = project(lonLat(routePoints[i]));
      if (from && to)
        scenarioArcs.push({
          key: `via-${i}`,
          d: arcPath(from, to),
          kind: "target",
        });
    }
  }

  const floodShapes = useMemo(
    () =>
      showSatellite
        ? data.observations.map((flood) => ({
            id: flood.id,
            extent: path(forD3(flood.extent)) || "",
            ring:
              path(
                geoCircle()
                  .center(lonLat(flood.center))
                  .radius((flood.radiusKm + data.checkRadiusKm) / 111.2)(),
              ) || "",
          }))
        : [],
    [showSatellite, data.observations, data.checkRadiusKm, path],
  );

  // Placing a supplier or site uses the 2D map, where a click maps to one point.
  if (view.id === "world" && globe && !globeUnavailable && !picking) {
    const globeMarkers = markers.filter(
      (m) => m.kind === "market" || m.kind === "origin",
    );
    if (start && !globeMarkers.some((m) => m.kind === "origin"))
      globeMarkers.unshift({
        key: "origin",
        kind: "origin",
        x: 0,
        y: 0,
        label: start.approximate ? companyOrigin : "Production",
        aria: start.approximate
          ? `Approximate start in ${companyOrigin}, from your company profile. No production site is recorded yet.`
          : "Your production sites and suppliers. Zoom in.",
        tone: "neutral",
        count: rows.length,
        side: "left",
        origin: true,
      });
    if (showSatellite)
      for (const observation of data.observations)
        globeMarkers.push({
          key: `flood-${observation.id}`,
          kind: "flood",
          x: 0,
          y: 0,
          label: `${observation.isSample ? "Sample flood" : "Flood"} · ${date(observation.observedOn)}`,
          aria: `${observation.isSample ? "Sample satellite observation" : "Satellite observation"}: ${observation.title}, ${date(observation.observedOn)}`,
          tone: "water",
          count: 0,
          side: "right",
          floodId: observation.id,
        });
    const points: GlobePoint[] = globeMarkers.map((m) => ({
      key: m.key,
      at:
        m.kind === "origin"
          ? start!.at
          : m.kind === "flood"
            ? lonLat(data.observations.find((o) => o.id === m.floodId)!.center)
            : lonLat(marketByCode.get(m.market!)!.hub),
      label: m.label,
      aria: m.aria,
      tone: marketTarget === m.market ? "target" : m.tone,
      count: m.count,
      selected: isSelected(m),
      related: isRelated(m),
      origin: m.kind === "origin",
      approximate: m.kind === "origin" && !!start?.approximate,
      observation: m.kind === "flood",
    }));
    const routes: GlobeRoute[] =
      showRoutes && start
        ? points
            .filter(
              (p) => !p.origin && !p.observation && (p.count > 0 || p.selected),
            )
            .map((p) => ({
              key: p.key,
              from: start.at,
              to: p.at,
              tone: routePoints.length > 1 ? "neutral" : p.tone,
              dim: routePoints.length > 1 || !p.related,
              approximate: start.approximate,
            }))
        : [];
    if (showRoutes && routePoints.length > 1) {
      // The API supplies the same ordered points used to calculate the distance.
      // Use the order's destination port, not the market's display hub.
      for (let i = 1; i < routePoints.length; i++) {
        const last = i === routePoints.length - 1;
        points.push({
          key: `route-stop-${i}`,
          at: lonLat(routePoints[i]),
          label: last
            ? (scenarioRow?.placement.city ?? "Destination")
            : routeComparison!.viaName!,
          aria: last
            ? `Proposed route destination: ${scenarioRow?.placement.city}`
            : `Proposed stop: ${routeComparison!.viaName}`,
          tone: "target",
          count: 0,
          selected: true,
          related: true,
        });
        routes.push({
          key: `route-leg-${i}`,
          connectionKey: "route-comparison",
          from: lonLat(routePoints[i - 1]),
          to: lonLat(routePoints[i]),
          tone: "target",
          dim: false,
          approximate: start?.approximate,
        });
      }
    }
    const countryColors = new Map(
      countries.map((c) => {
        const id = String(c.id);
        return [
          id,
          target.has(id)
            ? "#d7b774"
            : active.has(id)
              ? "#d7eda5"
              : tinted.has(id)
                ? "#a5be85"
                : home.has(id)
                  ? "#d0bf92"
                  : "#769181",
        ];
      }),
    );
    return (
      <div className="tm-globe-wrap">
        <TradeMapGlobe
          countries={countries}
          points={points}
          routes={routes}
          countryColors={countryColors}
          extents={showSatellite ? data.observations.map((o) => o.extent) : []}
          originApproximate={!!start?.approximate}
          routeLabel={showRoutes ? routeLabel : null}
          onSelect={(key) => {
            const marker = globeMarkers.find((m) => m.key === key);
            if (marker) onMarker(marker);
          }}
          onFallback={() => {
            setGlobeUnavailable(true);
            setGlobe(false);
          }}
        />
        <button className="tm-projection" onClick={() => setGlobe(false)}>
          2D map ↗
        </button>
        {!start && (
          <p className="tm-globe-empty">
            Add a company site with coordinates to connect your markets. No
            route origin is recorded yet.
          </p>
        )}
        {start?.approximate && (
          <p className="tm-globe-empty">
            Lines run from {companyOrigin} on your company profile to markets
            with orders. This is not a recorded production site.
          </p>
        )}
        {!countries.length && (
          <p className="tm-globe-loading" role="status">
            {atlasError
              ? "Country outlines unavailable. Trade connections are still shown."
              : "Loading country outlines…"}
          </p>
        )}
      </div>
    );
  }

  const pick = (event: React.MouseEvent) => {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
      matrix.inverse(),
    );
    const at = projection.invert?.([point.x, point.y]);
    // Outside the world outline, invert returns a point that doesn't project back.
    const back = at && projection(at);
    if (
      !at ||
      !back ||
      !Number.isFinite(at[0]) ||
      Math.hypot(back[0] - point.x, back[1] - point.y) > 1
    )
      return;
    const round = (n: number) => Math.round(n * 1e5) / 1e5;
    const country = countries.find((f) => geoContains(f, at));
    onPick(
      [round(((at[0] + 540) % 360) - 180), round(at[1])],
      country ? String(country.id) : null,
    );
  };
  const pinAt = pin && project(pin);

  return (
    <div
      className={"tm-canvas" + (picking ? " picking" : "")}
      ref={host}
      role="group"
      aria-label={`Trade map, ${view.label}`}
      onClick={picking ? pick : undefined}
    >
      {picking && (
        <p className="tm-pick-note" role="status">
          <MapPin size={13} /> Click the map to place it
          {view.bounds ? "" : ", or zoom in with the area tabs"}.
        </p>
      )}
      {view.id === "world" && !globeUnavailable && !picking && (
        <button className="tm-projection flat" onClick={() => setGlobe(true)}>
          3D globe ↗
        </button>
      )}
      {globeUnavailable && (
        <p className="tm-map-note" role="status">
          3D is unavailable on this device. Showing the 2D map.
        </p>
      )}
      {start?.approximate && showOrigin && !picking && (
        <p className="tm-map-note tm-origin-note" role="status">
          Lines run from {companyOrigin} on your company profile. This is not a
          recorded production site.
        </p>
      )}
      {showRoutes && routeLabel && (
        <p className="tm-route-preview" role="status">
          Proposed route · {routeLabel}
        </p>
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        aria-hidden="true"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <pattern
            id="tm-water"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" fill="#4d7d9a" fillOpacity="0.28" />
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="6"
              stroke="#2f6585"
              strokeWidth="2"
              strokeOpacity="0.55"
            />
          </pattern>
        </defs>
        <rect width={W} height={H} className="tm-sea" />
        {graticule && <path d={graticule} className="tm-graticule" />}
        <g>
          {countryPaths.map((c, i) => (
            <path
              key={c.id + "-" + i}
              d={c.d}
              className={
                "tm-land" +
                (target.has(c.id)
                  ? " target"
                  : active.has(c.id)
                    ? " active"
                    : tinted.has(c.id)
                      ? " market"
                      : home.has(c.id)
                        ? " home"
                        : "")
              }
            />
          ))}
        </g>
        {floodShapes.map((f) => (
          <g key={f.id} className="tm-flood">
            <path d={f.ring} className="tm-flood-ring" />
            <path d={f.extent} className="tm-flood-extent" />
          </g>
        ))}
        {arcs.map((a) => (
          <path
            key={a.key}
            d={a.d}
            className={`tm-arc tone-${a.tone} ${a.dim ? "dim" : ""} ${a.dashed ? "dashed" : ""}`}
            style={{ strokeWidth: a.width }}
          />
        ))}
        {scenarioArcs.map((a) => (
          <path key={a.key} d={a.d} className={`tm-arc scenario ${a.kind}`} />
        ))}
        {showRoutes &&
          routePoints.slice(1).map((point, i) => {
            const at = project(lonLat(point));
            if (!at) return null;
            return (
              <g
                key={`route-stop-${i}`}
                className="tm-route-stop"
                transform={`translate(${at[0]},${at[1]})`}
              >
                <circle r="5" />
                <text x="9" y="-8">
                  {i === routePoints.length - 2
                    ? scenarioRow?.placement.city
                    : routeComparison?.viaName}
                </text>
              </g>
            );
          })}
      </svg>
      {markers.map((m) => {
        const selected = isSelected(m);
        const side = labelSides.get(m.key);
        return (
          <button
            key={m.key}
            className={`tm-marker ${m.kind} tone-${m.tone} side-${side ?? "right"} ${side ? "" : "label-off"} ${selected ? "selected" : ""} ${isRelated(m) ? "" : "dim"} ${marketTarget && m.market === marketTarget ? "alt" : ""}`}
            style={
              {
                left: pct(m.x, W),
                top: pct(m.y, H),
                "--size": `${markerSize(m)}px`,
              } as React.CSSProperties
            }
            aria-label={m.aria}
            aria-pressed={selected}
            onClick={() => onMarker(m)}
          >
            <span className="tm-dot" aria-hidden="true">
              {m.kind === "market" && m.count > 0 ? m.count : null}
              {m.kind === "flood" ? <Waves size={11} /> : null}
            </span>
            <span className="tm-label" aria-hidden="true">
              {m.label}
              {m.kind === "port" && <b>{m.count}</b>}
            </span>
          </button>
        );
      })}
      {pinAt && (
        <span
          className="tm-pin"
          style={{ left: pct(pinAt[0], W), top: pct(pinAt[1], H) }}
          aria-hidden="true"
        >
          <MapPin size={24} />
        </span>
      )}
      {atlasError && !countries.length && (
        <p className="tm-map-note" role="status">
          Map outlines couldn't load. Places are still shown.
        </p>
      )}
    </div>
  );
}

type Box = [number, number, number, number];
const KIND_RANK: Record<Marker["kind"], number> = {
  market: 0,
  port: 0,
  origin: 1,
  supplier: 2,
  site: 3,
  flood: 4,
};
// Puts each label on the first side that covers no other marker or label,
// most important places first. Labels that don't fit show on hover and focus.
function placeLabels(
  markers: Marker[],
  scale: number,
  width: number,
  rank: (m: Marker) => number,
) {
  const height = width / 2;
  const boxes: Box[] = markers.map((m) => {
    const r = markerSize(m) / 2 + 1;
    return [m.x * scale - r, m.y * scale - r, m.x * scale + r, m.y * scale + r];
  });
  const sides = new Map<string, LabelSide | null>();
  const order = markers
    .map((_, i) => i)
    .sort((a, b) => rank(markers[a]) - rank(markers[b]));
  for (const i of order) {
    const m = markers[i];
    const x = m.x * scale,
      y = m.y * scale,
      r = markerSize(m) / 2,
      h = 17;
    const w =
      m.label.length * 5.9 +
      10 +
      (m.kind === "port" ? String(m.count).length * 6 + 5 : 0);
    const candidates: Record<LabelSide, Box> = {
      right: [x + r + 5, y - h / 2, x + r + 5 + w, y + h / 2],
      left: [x - r - 5 - w, y - h / 2, x - r - 5, y + h / 2],
      top: [x - w / 2, y - r - 4 - h, x + w / 2, y - r - 4],
      bottom: [x - w / 2, y + r + 4, x + w / 2, y + r + 4 + h],
    };
    const preferred = [
      m.side,
      ...(["right", "left", "top", "bottom"] as const).filter(
        (s) => s !== m.side,
      ),
    ];
    const side =
      preferred.find((s) => {
        const [x0, y0, x1, y1] = candidates[s];
        return (
          x0 >= 0 &&
          y0 >= 0 &&
          x1 <= width &&
          y1 <= height &&
          !boxes.some(
            (b, j) =>
              j !== i && x0 < b[2] && b[0] < x1 && y0 < b[3] && b[1] < y1,
          )
        );
      }) ?? null;
    if (side) boxes.push(candidates[side]);
    sides.set(m.key, side);
  }
  return sides;
}

// Nudges overlapping markers apart so each stays tappable on narrow screens.
// Flood markers stay pinned to the extent they describe.
function spread(markers: Marker[], scale: number) {
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let i = 0; i < markers.length; i++)
      for (let j = i + 1; j < markers.length; j++) {
        const a = markers[i],
          b = markers[j];
        if (a.kind === "flood" && b.kind === "flood") continue;
        const min = ((markerSize(a) + markerSize(b)) / 2 + 3) / scale;
        let dx = b.x - a.x,
          dy = b.y - a.y;
        if (!dx && !dy) dx = 0.01;
        const distance = Math.hypot(dx, dy);
        if (distance >= min) continue;
        const overlap = (min - distance) / distance;
        const share = a.kind === "flood" ? 0 : b.kind === "flood" ? 1 : 0.5;
        a.x -= dx * overlap * share;
        a.y -= dy * overlap * share;
        b.x += dx * overlap * (1 - share);
        b.y += dy * overlap * (1 - share);
        moved = true;
      }
    if (!moved) break;
  }
}
function markerSize(m: Marker) {
  if (m.kind === "market")
    return m.count ? Math.min(34, 18 + 2.4 * Math.sqrt(m.count)) : 14;
  if (m.kind === "origin") return 16;
  if (m.kind === "flood") return 20;
  if (m.kind === "port") return 12;
  if (m.kind === "supplier") return 12;
  return 10;
}

function PanelHead({
  eyebrow,
  title,
  sub,
  onBack,
}: {
  eyebrow: string;
  title: string;
  sub?: string | null;
  onBack?: () => void;
}) {
  return (
    <header className="tm-head">
      {onBack && (
        <button className="text-link tm-back" onClick={onBack}>
          <ArrowLeft size={14} />
          All places
        </button>
      )}
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      {sub && <p>{sub}</p>}
    </header>
  );
}

function OrderLine({
  row,
  renderStatus,
  onOpen,
  onCompare,
  note,
  show = "route",
}: {
  row: Row;
  renderStatus: (order: Order) => React.ReactNode;
  onOpen: (id: string) => void;
  onCompare?: (id: string) => void;
  note?: React.ReactNode;
  show?: "route" | "destination";
}) {
  const o = row.order;
  return (
    <li className="tm-order">
      <div className="tm-order-top">
        <button className="order-link" onClick={() => onOpen(o.id)}>
          {o.id}
        </button>
        {note ?? renderStatus(o)}
      </div>
      <b>{o.product}</b>
      <small>
        {show === "destination"
          ? o.destination
          : `${o.supplier} → ${row.placement.city || o.destination}`}{" "}
        · ships {date(o.shipDate)} · {money(o.value, o.currency)}
      </small>
      {(row.gaps.length > 0 || onCompare) && (
        <div className="tm-order-foot">
          {row.gaps.length > 0 && (
            <span className="tm-gap">
              {plural(row.gaps.length, "document gap")}
            </span>
          )}
          {onCompare && (
            <button className="text-link" onClick={() => onCompare(o.id)}>
              <ArrowLeftRight size={13} />
              Compare another market
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function FloodCallout({
  flood,
  detail,
  onOpen,
}: {
  flood: SatelliteObservation;
  detail: string;
  onOpen: () => void;
}) {
  return (
    <button className="tm-callout tm-callout-row" onClick={onOpen}>
      <span>
        <span className="eyebrow">
          <Satellite size={13} /> SATELLITE{flood.isSample ? " · SAMPLE" : ""}
        </span>
        <b>{flood.title}</b>
        <small>
          {date(flood.observedOn)} · {detail}
        </small>
      </span>
      <ArrowUpRight size={15} />
    </button>
  );
}

function OverviewPanel({
  orderCount,
  markets,
  suppliers,
  sites,
  floods,
  unplaced,
  unlocated,
  onMarket,
  onSupplier,
  onSite,
  onFlood,
  onImport,
  onAddSupplier,
  onAddSite,
}: {
  orderCount: number;
  markets: MarketSummary[];
  suppliers: SupplierGroup[];
  sites: MapSite[];
  floods: FloodEntry[];
  unplaced: Row[];
  unlocated: SupplierGroup[];
  onMarket: (code: string) => void;
  onSupplier: (name: string) => void;
  onSite: (id: string) => void;
  onFlood: (flood: SatelliteObservation) => void;
  onImport: () => void;
  // Editors only. A supplier named on orders opens with its name filled in.
  onAddSupplier?: (group?: SupplierGroup) => void;
  onAddSite?: () => void;
}) {
  const nearby = floods.filter((f) => f.suppliers.length || f.sites.length);
  return (
    <>
      <PanelHead
        eyebrow="YOUR TRADE, BY PLACE"
        title="Pick a place."
        sub="Choose a market, supplier or site to see its orders, the changes to check and the documents still missing."
      />
      {!orderCount && (
        <div className="tm-empty">
          <p>No orders yet. Import orders to see where your trade goes.</p>
          <button className="text-link" onClick={onImport}>
            Import orders <ArrowUpRight size={14} />
          </button>
        </div>
      )}
      {nearby.map(({ flood, suppliers: near, sites: nearSites }) => (
        <FloodCallout
          key={flood.id}
          flood={flood}
          detail={[
            near.length
              ? `${plural(near.length, "supplier")} to check in with`
              : "",
            nearSites.length ? `${nearSites.length} of your sites nearby` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          onOpen={() => onFlood(flood)}
        />
      ))}
      {markets.length > 0 && (
        <section className="tm-section">
          <h3>Markets</h3>
          <ul className="tm-list">
            {markets.map(({ market, rows, tone }) => {
              const gaps = rows.filter((r) => r.gaps.length).length;
              return (
                <li key={market.code}>
                  <button onClick={() => onMarket(market.code)}>
                    <i className={`tm-key market tone-${tone}`} />
                    <span>
                      <b>{market.name}</b>
                      <small>
                        {plural(rows.length, "order")}
                        {gaps ? ` · ${gaps} with document gaps` : ""}
                      </small>
                    </span>
                    <ArrowUpRight size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {(suppliers.length > 0 || onAddSupplier) && (
        <section className="tm-section">
          <SectionHead
            title="Suppliers"
            action={onAddSupplier && (() => onAddSupplier())}
            actionLabel="Add supplier"
          />
          {!suppliers.length && (
            <p className="tm-muted">
              No suppliers yet. Add one to check its documents against your
              orders.
            </p>
          )}
          <ul className="tm-list">
            {suppliers.map((s) => (
              <li key={s.key}>
                <button onClick={() => onSupplier(s.name)}>
                  <i className="tm-key supplier" />
                  <span>
                    <b>{s.name}</b>
                    <small>
                      {s.place ?? "Location not on file"} ·{" "}
                      {s.rows.length
                        ? plural(s.rows.length, "order")
                        : "no open orders"}
                    </small>
                  </span>
                  <ArrowUpRight size={14} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="tm-section">
        <SectionHead
          title="Your sites"
          action={onAddSite}
          actionLabel="Add site"
        />
        {sites.length ? (
          <ul className="tm-list">
            {sites.map((s) => (
              <li key={s.key}>
                <button onClick={() => onSite(s.key)}>
                  <i className="tm-key site" />
                  <span>
                    <b>{s.name}</b>
                    <small>{s.place}</small>
                  </span>
                  <ArrowUpRight size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="tm-muted">No sites recorded for your company yet.</p>
        )}
      </section>
      {(unplaced.length > 0 || unlocated.length > 0) && (
        <section className="tm-section">
          <h3>Not on the map</h3>
          <ul className="tm-plain">
            {unplaced.map((r) => (
              <li key={r.order.id}>
                <b>{r.order.id}</b> · destination “{r.order.destination}”
                couldn't be placed.{" "}
                {r.placement.country
                  ? `${r.placement.country} isn't one of the markets on this map yet.`
                  : "Write it as “City, CC”, for example “Rotterdam, NL”."}
              </li>
            ))}
            {unlocated.map((s) => (
              <li key={s.key}>
                <b>{s.name}</b> ·{" "}
                {s.id ? "no location on file" : "no supplier record"} (
                {plural(s.rows.length, "order")}).{" "}
                {onAddSupplier && (
                  <button className="text-link" onClick={() => onAddSupplier(s)}>
                    {s.id ? "Add its location" : "Add a supplier record"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function MarketPanel({
  market,
  rows,
  impacts,
  toneOf,
  renderStatus,
  onBack,
  onOpenOrder,
  onCompare,
  onSupplier,
  onNews,
}: {
  market: MapMarket;
  rows: Row[];
  impacts: Impact[];
  toneOf: (order: Order) => Tone;
  renderStatus: (order: Order) => React.ReactNode;
  onBack: () => void;
  onOpenOrder: (id: string) => void;
  onCompare: (id: string) => void;
  onSupplier: (name: string) => void;
  onNews: () => void;
}) {
  const sorted = [...rows].sort(byShipDate);
  const ports = [...new Set(rows.map((r) => r.placement.city))];
  const value = rows.reduce<Record<string, number>>((sum, r) => {
    const currency = r.order.currency || "USD";
    sum[currency] = (sum[currency] || 0) + r.order.value;
    return sum;
  }, {});

  const actionNeeded = sorted.filter((r) => toneOf(r.order) === "red");
  const tariffChecks = sorted.filter((r) =>
    r.checks.some((c) => c.status === "check"),
  );
  const products = new Set(rows.map((r) => productKey(r.order.product)));
  const terms = marketTerms(market);
  const news = terms
    ? impacts
        .map((impact) => ({
          impact,
          touched: impact.affected.filter((a) =>
            products.has(productKey(a.name)),
          ),
          named: terms.test(`${impact.title} ${impact.headline} ${impact.why}`),
        }))
        .filter((n) => n.named)
        .sort((a, b) => b.touched.length - a.touched.length)
        .slice(0, 3)
    : [];

  const gaps = new Map<
    string,
    { check: RequirementCheck; supplier: string; orders: string[] }
  >();
  for (const row of sorted)
    for (const check of row.gaps) {
      const key = `${check.requirementKey}|${check.status}|${supplierKey(row.order.supplier)}`;
      const entry = gaps.get(key) ?? {
        check,
        supplier: row.order.supplier,
        orders: [],
      };
      entry.orders.push(row.order.id);
      gaps.set(key, entry);
    }
  const noRecord = [
    ...new Set(
      rows
        .filter((r) => r.checks.some((c) => c.status === "unknown"))
        .map((r) => r.order.supplier),
    ),
  ];
  const perShipment = new Map<string, string>();
  for (const row of rows)
    for (const check of row.checks)
      if (check.status === "prepare") perShipment.set(check.title, check.note);

  return (
    <>
      <PanelHead
        eyebrow={`MARKET · ${ports.slice(0, 4).join(" · ").toUpperCase()}${ports.length > 4 ? " …" : ""}`}
        title={market.name + "."}
        sub={`${plural(rows.length, "open order")} · ${Object.entries(value)
          .map(([currency, total]) => money(total, currency))
          .join(" + ")}`}
        onBack={onBack}
      />
      <section className="tm-section">
        <h3>Orders here</h3>
        <ul className="tm-orders">
          {sorted.map((row) => (
            <OrderLine
              key={row.order.id}
              row={row}
              renderStatus={renderStatus}
              onOpen={onOpenOrder}
              onCompare={onCompare}
            />
          ))}
        </ul>
      </section>
      <section className="tm-section">
        <h3>Changes to check</h3>
        {!actionNeeded.length && !tariffChecks.length && !news.length && (
          <p className="tm-muted">
            No tracked changes for this market right now.
          </p>
        )}
        {actionNeeded.length > 0 && (
          <div className="tm-change">
            <span className="status red">
              <i />
              {plural(actionNeeded.length, "order")} need action
            </span>
            <p>
              A tracked change already affects these orders. Open each one to
              see what changed and the next step.
            </p>
            <div className="order-tags">
              {actionNeeded.map((r) => (
                <button
                  key={r.order.id}
                  onClick={() => onOpenOrder(r.order.id)}
                >
                  {r.order.id}
                  <ArrowUpRight size={12} />
                </button>
              ))}
            </div>
          </div>
        )}
        {tariffChecks.length > 0 && (
          <div className="tm-change">
            <span className="status amber">
              <i />
              Landed cost
            </span>
            <p>
              {tariffChecks[0].checks.find((c) => c.status === "check")!.note}
            </p>
            <div className="order-tags">
              {tariffChecks.map((r) => (
                <button
                  key={r.order.id}
                  onClick={() => onOpenOrder(r.order.id)}
                >
                  {r.order.id}
                  <ArrowUpRight size={12} />
                </button>
              ))}
            </div>
          </div>
        )}
        {news.map(({ impact, touched }) => (
          <div className="tm-change" key={impact.id}>
            <span
              className={`status ${impact.direction === "opportunity" ? "green" : impact.severity === "high" ? "red" : "amber"}`}
            >
              <i />
              NEWS · {impact.severity.toUpperCase()}
            </span>
            <p>
              <b>{impact.headline}</b>
              {touched.length > 0 && (
                <>
                  {" "}
                  Mentions products you ship here:{" "}
                  {touched.map((t) => t.name).join(", ")}.
                </>
              )}
            </p>
            <small className="tm-muted">
              {impact.publisher} ·{" "}
              {impact.publishedAt
                ? date(impact.publishedAt.slice(0, 10))
                : "undated"}
            </small>
          </div>
        ))}
        {news.length > 0 && (
          <button className="text-link" onClick={onNews}>
            Open News watch to verify <ArrowUpRight size={14} />
          </button>
        )}
      </section>
      <section className="tm-section">
        <h3>Missing documents</h3>
        {gaps.size === 0 && !noRecord.length && (
          <p className="tm-ok">
            <Check size={15} /> Every supplier document this market asks for is
            on file.
          </p>
        )}
        <ul className="tm-gaps">
          {[...gaps.values()].map(({ check, supplier, orders: ids }) => (
            <li key={check.requirementKey + supplier + check.status}>
              <span
                className={`status ${check.status === "missing" ? "red" : "amber"}`}
              >
                <i />
                {check.status === "missing" ? "Missing" : "Wrong standard"}
              </span>
              <b>{check.title}</b>
              <p>
                {check.note}{" "}
                <button
                  className="tm-inline"
                  onClick={() => onSupplier(supplier)}
                >
                  {supplier}
                </button>{" "}
                · {ids.join(", ")}
              </p>
            </li>
          ))}
          {noRecord.map((name) => (
            <li key={name}>
              <span className="status">
                <CircleHelp size={11} />
                Unknown
              </span>
              <b>{name}</b>
              <p>
                No document record for this supplier, so its documents can't be
                checked.
              </p>
            </li>
          ))}
        </ul>
        {perShipment.size > 0 && (
          <p className="fine-print">
            Prepared per shipment:{" "}
            {[...perShipment.entries()]
              .map(([title, form]) => `${title} (${form})`)
              .join("; ")}
            .
          </p>
        )}
        <h3>Requirement sources</h3>
        {[
          ...new Map(
            sorted
              .flatMap((row) => row.checks)
              .filter((check) => check.source)
              .map((check) => [check.requirementKey, check]),
          ).values(),
        ].map((check) => (
          <RegulationCitation
            key={check.requirementKey}
            source={check.source}
          />
        ))}
        <p className="fine-print">
          Checklist for {market.name} is illustrative, not legal guidance;
          confirm with official sources and your buyer.
        </p>
      </section>
    </>
  );
}

function SupplierPanel({
  group,
  documentKinds,
  floods,
  marketByCode,
  renderStatus,
  onBack,
  onOpenOrder,
  onCompare,
  onMarket,
  onFlood,
  onEdit,
}: {
  group: SupplierGroup;
  documentKinds: TradeMap["documentKinds"];
  floods: FloodEntry[];
  marketByCode: Map<string, MapMarket>;
  renderStatus: (order: Order) => React.ReactNode;
  onBack: () => void;
  onOpenOrder: (id: string) => void;
  onCompare: (id: string) => void;
  onMarket: (code: string) => void;
  onFlood: (flood: SatelliteObservation) => void;
  onEdit?: (group: SupplierGroup) => void;
}) {
  const near = floods.flatMap((f) =>
    f.suppliers
      .filter((s) => s.group.key === group.key)
      .map((s) => ({ flood: f.flood, km: s.km })),
  );
  const served = [
    ...new Set(group.rows.map((r) => r.placement.market).filter(Boolean)),
  ] as string[];
  return (
    <>
      <PanelHead
        eyebrow={`SUPPLIER · ${group.place?.toUpperCase() ?? "LOCATION NOT ON FILE"}`}
        title={group.name + "."}
        sub={group.supplies}
        onBack={onBack}
      />
      {onEdit && (
        <button className="text-link tm-edit" onClick={() => onEdit(group)}>
          {group.id ? <Pencil size={13} /> : <Plus size={13} />}
          {group.id ? "Edit supplier" : "Add a supplier record"}
        </button>
      )}
      {near.map(({ flood, km }) => (
        <FloodCallout
          key={flood.id}
          flood={flood}
          detail={`${km === 0 ? "inside the observed extent" : `${km} km from the observed edge`}. Worth a check-in; impact unconfirmed.`}
          onOpen={() => onFlood(flood)}
        />
      ))}
      <section className="tm-section">
        <h3>Open orders</h3>
        {group.rows.length ? (
          <ul className="tm-orders">
            {[...group.rows].sort(byShipDate).map((row) => (
              <OrderLine
                key={row.order.id}
                row={row}
                renderStatus={renderStatus}
                onOpen={onOpenOrder}
                onCompare={onCompare}
                show="destination"
              />
            ))}
          </ul>
        ) : (
          <p className="tm-muted">No open orders with this supplier.</p>
        )}
        {served.length > 0 && (
          <div className="tm-chips" aria-label="Markets served">
            {served.map((code) => (
              <button key={code} onClick={() => onMarket(code)}>
                {marketByCode.get(code)?.name ?? code}
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="tm-section">
        <h3>Documents on file</h3>
        {!group.documents ? (
          <p className="tm-muted">
            No supplier record yet, so there are no documents to show
            {onEdit ? ". Add one to record what this supplier has on file." : "."}
          </p>
        ) : (
          <ul className="tm-docs">
            {documentKinds.map(({ kind, label }) => {
              const doc = group.documents!.find((d) => d.kind === kind);
              return (
                <li key={kind} className={doc ? "on" : "off"}>
                  {doc ? <Check size={14} /> : <X size={14} />}
                  <span>
                    <b>{label}</b>
                    <small>
                      {doc
                        ? [doc.detail, doc.standards.join(", ")]
                            .filter(Boolean)
                            .join(" · ")
                        : "Not on file"}
                    </small>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

function SitePanel({
  site,
  suppliers,
  floods,
  checkRadiusKm,
  onBack,
  onSupplier,
  onFlood,
  onEdit,
}: {
  site: MapSite;
  suppliers: SupplierGroup[];
  floods: FloodEntry[];
  checkRadiusKm: number;
  onBack: () => void;
  onSupplier: (name: string) => void;
  onFlood: (flood: SatelliteObservation) => void;
  onEdit?: (site: MapSite) => void;
}) {
  const near = floods.flatMap((f) =>
    f.sites
      .filter((s) => s.site.key === site.key)
      .map((s) => ({ flood: f.flood, km: s.km })),
  );
  return (
    <>
      <PanelHead
        eyebrow={`YOUR SITE · ${site.place.toUpperCase()}`}
        title={site.name + "."}
        sub={site.note}
        onBack={onBack}
      />
      {onEdit && (
        <button className="text-link tm-edit" onClick={() => onEdit(site)}>
          <Pencil size={13} />
          Edit site
        </button>
      )}
      {site.isRouteOrigin && (
        <p className="tm-muted">Order routes on the world map start here.</p>
      )}
      {near.map(({ flood, km }) => (
        <FloodCallout
          key={flood.id}
          flood={flood}
          detail={`${km} km from the observed edge. Check stock and road access.`}
          onOpen={() => onFlood(flood)}
        />
      ))}
      {!near.length && (
        <p className="tm-ok">
          <Check size={15} /> No matching observations in this dataset within{" "}
          {checkRadiusKm} km. This does not confirm that the site is unaffected.
        </p>
      )}
      {site.kind === "factory" && (
        <section className="tm-section">
          <h3>Company suppliers with open orders</h3>
          <ul className="tm-list">
            {suppliers
              .filter((s) => s.rows.length)
              .map((s) => (
                <li key={s.key}>
                  <button onClick={() => onSupplier(s.name)}>
                    <i className="tm-key supplier" />
                    <span>
                      <b>{s.name}</b>
                      <small>
                        {s.place ?? "Location not on file"} ·{" "}
                        {plural(s.rows.length, "order")}
                      </small>
                    </span>
                    <ArrowUpRight size={14} />
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}
    </>
  );
}

function SectionHead({
  title,
  action,
  actionLabel,
}: {
  title: string;
  action?: () => void;
  actionLabel: string;
}) {
  return (
    <div className="tm-section-head">
      <h3>{title}</h3>
      {action && (
        <button className="text-link" onClick={action}>
          <Plus size={13} />
          {actionLabel}
        </button>
      )}
    </div>
  );
}

// Latitude first, the way map apps copy a point: "10.95, 106.82".
function parseLocation(text: string): LonLat | null | "invalid" {
  const value = text.trim();
  if (!value) return null;
  const match = /^(-?\d+(?:\.\d+)?)°?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)°?$/.exec(
    value,
  );
  if (!match) return "invalid";
  const lat = Number(match[1]),
    lon = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : "invalid";
}
const formatLocation = ([lon, lat]: LonLat) =>
  `${Number(lat.toFixed(5))}, ${Number(lon.toFixed(5))}`;

function LocationField({
  id,
  pin,
  required,
  onPin,
  onValid,
}: {
  id: string;
  pin: Pin | null;
  required?: boolean;
  onPin: (pin: Pin | null) => void;
  onValid: (valid: boolean) => void;
}) {
  const [text, setText] = useState(pin ? formatLocation(pin.at) : "");
  // A click on the map replaces whatever was typed.
  useEffect(() => {
    if (!pin?.picked) return;
    setText(formatLocation(pin.at));
    onValid(true);
  }, [pin?.picked]);
  const invalid = parseLocation(text) === "invalid";
  return (
    <>
      <label htmlFor={id}>Location{required ? "" : " (optional)"}</label>
      <input
        id={id}
        value={text}
        required={required}
        autoComplete="off"
        placeholder="10.95, 106.82"
        aria-invalid={invalid}
        aria-describedby={id + "-hint"}
        onChange={(e) => {
          setText(e.target.value);
          const next = parseLocation(e.target.value);
          onValid(next !== "invalid");
          onPin(
            next && next !== "invalid"
              ? { at: next, country: null, picked: pin?.picked ?? 0 }
              : null,
          );
        }}
      />
      <small id={id + "-hint"} className={invalid ? "tm-field-error" : ""}>
        {invalid
          ? "Write latitude, then longitude, for example 10.95, 106.82."
          : "Click the map, or paste latitude and longitude from a map app."}
      </small>
    </>
  );
}

function CountryField({
  id,
  value,
  countries,
  onChange,
}: {
  id: string;
  value: string;
  countries: TradeMap["countries"];
  onChange: (code: string) => void;
}) {
  return (
    <>
      <label htmlFor={id}>Country</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Not set</option>
        {countries.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </select>
    </>
  );
}

function FormActions({
  busy,
  saveLabel,
  error,
  onCancel,
}: {
  busy: boolean;
  saveLabel: string;
  error: string;
  onCancel: () => void;
}) {
  return (
    <>
      {error && (
        <p className="tm-field-error" role="alert">
          {error}
        </p>
      )}
      <div className="tm-form-actions">
        <button className="btn" type="submit" disabled={busy}>
          {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
          {saveLabel}
        </button>
        <button className="text-link" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

function DeleteRecord({
  what,
  consequence,
  busy,
  onDelete,
}: {
  what: string;
  consequence: string;
  busy: boolean;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return (
      <button
        type="button"
        className="text-link tm-delete"
        onClick={() => setConfirming(true)}
      >
        <Trash2 size={13} />
        Delete {what}
      </button>
    );
  return (
    <div className="tm-confirm" role="group" aria-label={`Delete ${what}`}>
      <p>{consequence}</p>
      <div className="tm-form-actions">
        <button
          type="button"
          className="btn tm-danger"
          disabled={busy}
          onClick={onDelete}
        >
          <Trash2 size={15} />
          Delete {what}
        </button>
        <button
          type="button"
          className="text-link"
          onClick={() => setConfirming(false)}
        >
          Keep it
        </button>
      </div>
    </div>
  );
}

type DocumentDraft = {
  on: boolean;
  detail: string;
  standards: string;
  number: string;
  issuer: string;
  expiresOn: string;
};

function SupplierForm({
  group,
  name: suggestedName,
  documentKinds,
  countries,
  pin,
  onPin,
  onSaved,
  onDeleted,
  onCancel,
}: {
  group: SupplierGroup | null;
  name?: string;
  documentKinds: TradeMap["documentKinds"];
  countries: TradeMap["countries"];
  pin: Pin | null;
  onPin: (pin: Pin | null) => void;
  onSaved: (name: string) => Promise<void>;
  onDeleted: () => Promise<void>;
  onCancel: () => void;
}) {
  const record = group?.id ? group : null;
  const [name, setName] = useState(group?.name ?? suggestedName ?? "");
  const [place, setPlace] = useState(record?.place ?? "");
  const [country, setCountry] = useState(record?.country ?? "");
  const [supplies, setSupplies] = useState(record?.supplies ?? "");
  const [contactName, setContactName] = useState(record?.contactName ?? "");
  const [contactEmail, setContactEmail] = useState(record?.contactEmail ?? "");
  const [documents, setDocuments] = useState<Record<string, DocumentDraft>>(
    () =>
      Object.fromEntries(
        documentKinds.map(({ kind }) => {
          const doc = record?.documents?.find((d) => d.kind === kind);
          return [
            kind,
            {
              on: !!doc,
              detail: doc?.detail ?? "",
              standards: doc?.standards.join(", ") ?? "",
              number: doc?.documentNumber ?? "",
              issuer: doc?.issuer ?? "",
              expiresOn: doc?.expiresOn ?? "",
            },
          ];
        }),
      ),
  );
  const [locationValid, setLocationValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (pin?.picked && pin.country) setCountry(pin.country);
  }, [pin?.picked]);
  const editDocument = (kind: string, change: Partial<DocumentDraft>) =>
    setDocuments((all) => ({ ...all, [kind]: { ...all[kind], ...change } }));
  const renamed =
    !!record && !!name.trim() && supplierKey(name) !== record.key;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!locationValid)
      return setError("Fix the location, or leave it empty.");
    const body: SupplierInput = {
      name: name.trim(),
      place: place.trim() || null,
      country: country || null,
      location: pin ? { latitude: pin.at[1], longitude: pin.at[0] } : null,
      supplies: supplies.trim() || null,
      contactName: contactName.trim() || null,
      contactEmail: contactEmail.trim() || null,
      documents: documentKinds
        .filter(({ kind }) => documents[kind].on)
        .map(({ kind }) => ({
          kind,
          detail: documents[kind].detail.trim(),
          standards: documents[kind].standards
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          documentNumber: documents[kind].number.trim() || null,
          issuer: documents[kind].issuer.trim() || null,
          expiresOn: documents[kind].expiresOn || null,
        })),
    };
    run(async () => {
      const saved = record
        ? await api.updateSupplier(record.id!, body)
        : await api.createSupplier(body);
      await onSaved(saved.name);
    });
  };

  return (
    <form className="tm-form" onSubmit={submit}>
      <PanelHead
        eyebrow={record ? "EDIT SUPPLIER" : "NEW SUPPLIER"}
        title={record ? record.name + "." : "Add a supplier."}
        sub="Orders are matched to a supplier by name, ignoring case and spacing."
      />
      <label htmlFor="tm-supplier-name">Name</label>
      <input
        id="tm-supplier-name"
        required
        maxLength={300}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="As it's written on your orders"
      />
      {renamed && record.rows.length > 0 && (
        <small className="tm-field-error">
          {plural(record.rows.length, "order")} name “{record.name}”. After
          renaming, they won't be checked against this supplier.
        </small>
      )}
      <label htmlFor="tm-supplier-place">Place (optional)</label>
      <input
        id="tm-supplier-place"
        maxLength={200}
        value={place}
        onChange={(e) => setPlace(e.target.value)}
        placeholder="Town, province"
      />
      <CountryField
        id="tm-supplier-country"
        value={country}
        countries={countries}
        onChange={setCountry}
      />
      <LocationField
        id="tm-supplier-location"
        pin={pin}
        onPin={onPin}
        onValid={setLocationValid}
      />
      <label htmlFor="tm-supplier-supplies">What they supply (optional)</label>
      <textarea
        id="tm-supplier-supplies"
        maxLength={1000}
        value={supplies}
        onChange={(e) => setSupplies(e.target.value)}
        placeholder="Acacia plywood, rubberwood panels"
      />
      <label htmlFor="tm-supplier-contact-name">Contact person (optional)</label>
      <input
        id="tm-supplier-contact-name"
        maxLength={200}
        value={contactName}
        onChange={(e) => setContactName(e.target.value)}
        placeholder="Nguyen Van Minh"
      />
      <label htmlFor="tm-supplier-contact-email">Contact email (optional)</label>
      <input
        id="tm-supplier-contact-email"
        type="email"
        maxLength={254}
        value={contactEmail}
        onChange={(e) => setContactEmail(e.target.value)}
        placeholder="sales@supplier.com"
      />
      <fieldset className="tm-doc-fields">
        <legend>Documents on file</legend>
        <small>
          Tick what this supplier has given you. Orders' market checklists are
          checked against it.
        </small>
        {documentKinds.map(({ kind, label }) => {
          const doc = documents[kind];
          return (
            <div key={kind} className={"tm-doc-field" + (doc.on ? " on" : "")}>
              <label className="tm-check">
                <input
                  type="checkbox"
                  checked={doc.on}
                  onChange={(e) => editDocument(kind, { on: e.target.checked })}
                />
                {label}
              </label>
              {doc.on && (
                <>
                  <input
                    aria-label={`${label}: what's on file`}
                    required
                    maxLength={500}
                    value={doc.detail}
                    onChange={(e) =>
                      editDocument(kind, { detail: e.target.value })
                    }
                    placeholder="What's on file, e.g. Test report, Mar 2026"
                  />
                  <input
                    aria-label={`${label}: test standards`}
                    value={doc.standards}
                    onChange={(e) =>
                      editDocument(kind, { standards: e.target.value })
                    }
                    placeholder="Test standards, comma-separated (optional)"
                  />
                  <input
                    aria-label={`${label}: document number`}
                    maxLength={100}
                    value={doc.number}
                    onChange={(e) =>
                      editDocument(kind, { number: e.target.value })
                    }
                    placeholder="Document number (optional)"
                  />
                  <input
                    aria-label={`${label}: issuer`}
                    maxLength={200}
                    value={doc.issuer}
                    onChange={(e) =>
                      editDocument(kind, { issuer: e.target.value })
                    }
                    placeholder="Issued by (optional)"
                  />
                  <label className="tm-doc-expiry">
                    Expires on (optional)
                    <input
                      type="date"
                      aria-label={`${label}: expires on`}
                      value={doc.expiresOn}
                      onChange={(e) =>
                        editDocument(kind, { expiresOn: e.target.value })
                      }
                    />
                  </label>
                </>
              )}
            </div>
          );
        })}
      </fieldset>
      <FormActions
        busy={busy}
        saveLabel={record ? "Save supplier" : "Add supplier"}
        error={error}
        onCancel={onCancel}
      />
      {record && (
        <DeleteRecord
          what="supplier"
          busy={busy}
          consequence={`Delete ${record.name} and its documents? ${
            record.rows.length
              ? `Its ${plural(record.rows.length, "order")} stay, without a supplier record to check.`
              : ""
          }`}
          onDelete={() =>
            run(async () => {
              await api.deleteSupplier(record.id!);
              await onDeleted();
            })
          }
        />
      )}
    </form>
  );
}

const SITE_KINDS: { kind: MapSite["kind"]; label: string }[] = [
  { kind: "factory", label: "Factory" },
  { kind: "warehouse", label: "Warehouse" },
  { kind: "port", label: "Port" },
];

function SiteForm({
  site,
  originName,
  countries,
  pin,
  onPin,
  onSaved,
  onDeleted,
  onCancel,
}: {
  site: MapSite | null;
  originName: string | null; // the site routes start from now, if any
  countries: TradeMap["countries"];
  pin: Pin | null;
  onPin: (pin: Pin | null) => void;
  onSaved: (key: string) => Promise<void>;
  onDeleted: () => Promise<void>;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<MapSite["kind"]>(site?.kind ?? "factory");
  const [name, setName] = useState(site?.name ?? "");
  const [shortName, setShortName] = useState(
    site && site.shortName !== site.name ? site.shortName : "",
  );
  const [place, setPlace] = useState(site?.place ?? "");
  const [country, setCountry] = useState(site?.country ?? "");
  const [note, setNote] = useState(site?.note ?? "");
  const [origin, setOrigin] = useState(
    site ? site.isRouteOrigin : !originName,
  );
  const [locationValid, setLocationValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (pin?.picked && pin.country) setCountry(pin.country);
  }, [pin?.picked]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!locationValid || !pin)
      return setError("Click the map where the site is, or enter its coordinates.");
    const body: SiteInput = {
      kind,
      name: name.trim(),
      shortName: shortName.trim() || name.trim().slice(0, 60).trim(),
      place: place.trim(),
      country: country || null,
      location: { latitude: pin.at[1], longitude: pin.at[0] },
      note: note.trim(),
      isRouteOrigin: origin,
    };
    run(async () => {
      const saved = site
        ? await api.updateSite(site.id, body)
        : await api.createSite(body);
      await onSaved(saved.key);
    });
  };
  const movesOrigin =
    origin && !site?.isRouteOrigin && originName && originName !== site?.name;

  return (
    <form className="tm-form" onSubmit={submit}>
      <PanelHead
        eyebrow={site ? "EDIT SITE" : "NEW SITE"}
        title={site ? site.name + "." : "Add a site."}
        sub="A factory, warehouse or port of your own."
      />
      <label htmlFor="tm-site-kind">Kind</label>
      <select
        id="tm-site-kind"
        value={kind}
        onChange={(e) => setKind(e.target.value as MapSite["kind"])}
      >
        {SITE_KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </select>
      <label htmlFor="tm-site-name">Name</label>
      <input
        id="tm-site-name"
        required
        maxLength={200}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Cat Lai bonded warehouse"
      />
      <label htmlFor="tm-site-short">Label on the map (optional)</label>
      <input
        id="tm-site-short"
        maxLength={60}
        value={shortName}
        onChange={(e) => setShortName(e.target.value)}
        placeholder={name.trim().slice(0, 60) || "Cat Lai"}
      />
      <label htmlFor="tm-site-place">Place</label>
      <input
        id="tm-site-place"
        required
        maxLength={200}
        value={place}
        onChange={(e) => setPlace(e.target.value)}
        placeholder="Ho Chi Minh City port"
      />
      <CountryField
        id="tm-site-country"
        value={country}
        countries={countries}
        onChange={setCountry}
      />
      <LocationField
        id="tm-site-location"
        pin={pin}
        required
        onPin={onPin}
        onValid={setLocationValid}
      />
      <label htmlFor="tm-site-note">Note (optional)</label>
      <textarea
        id="tm-site-note"
        maxLength={1000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Production and warehouses WH-1, WH-2."
      />
      <label className="tm-check">
        <input
          type="checkbox"
          checked={origin}
          onChange={(e) => setOrigin(e.target.checked)}
        />
        Order routes start here
      </label>
      <small>
        {movesOrigin
          ? `Routes start from ${originName} now. Saving moves the start here.`
          : "Routes on the world map, and route comparisons, start from one site."}
      </small>
      <FormActions
        busy={busy}
        saveLabel={site ? "Save site" : "Add site"}
        error={error}
        onCancel={onCancel}
      />
      {site && (
        <DeleteRecord
          what="site"
          busy={busy}
          consequence={`Delete ${site.name}?${
            site.isRouteOrigin
              ? " Routes start here; without it they start from your company profile's origin, or not at all."
              : ""
          }`}
          onDelete={() =>
            run(async () => {
              await api.deleteSite(site.id);
              await onDeleted();
            })
          }
        />
      )}
    </form>
  );
}

function FloodPanel({
  entry,
  checkRadiusKm,
  signature,
  renderStatus,
  onBack,
  onOpenOrder,
  onSupplier,
}: {
  entry: FloodEntry;
  checkRadiusKm: number;
  signature: string;
  renderStatus: (order: Order) => React.ReactNode;
  onBack: () => void;
  onOpenOrder: (id: string) => void;
  onSupplier: (name: string) => void;
}) {
  const { flood, suppliers, sites } = entry;
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const openDraft = (group: SupplierGroup, km: number) => {
    setDraftFor(group.key);
    setDraft(checkInDraft(flood, group, km, signature));
    setCopied(false);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
    } catch {
      draftRef.current?.select();
    }
  };
  const affected = suppliers.flatMap((s) => s.group.rows).sort(byShipDate);
  return (
    <>
      <PanelHead
        eyebrow={`SATELLITE EVIDENCE${flood.isSample ? " · SAMPLE OBSERVATION" : ""}`}
        title={flood.title + "."}
        sub={flood.place}
        onBack={onBack}
      />
      <dl className="tm-facts">
        <dt>Observed</dt>
        <dd>
          {date(flood.observedOn)} {flood.observedOn.slice(0, 4)}
        </dd>
        <dt>Source</dt>
        <dd>
          {flood.sourceUrl ? (
            <a href={flood.sourceUrl} target="_blank" rel="noreferrer">
              {flood.sensor}
            </a>
          ) : (
            flood.sensor
          )}
        </dd>
        <dt>Water extent</dt>
        <dd>≈ {flood.areaKm2} km²</dd>
        <dt>Confidence</dt>
        <dd
          className={
            "tm-confidence " + (flood.confidence === "low" ? "warn" : "")
          }
        >
          {flood.confidence}
        </dd>
      </dl>
      <p className="tm-muted">{flood.confidenceNote}</p>
      <section className="tm-section">
        <h3>Who to check in with</h3>
        {!suppliers.length && !sites.length && (
          <p className="tm-muted">
            No suppliers or sites within {checkRadiusKm} km of the observed
            edge.
          </p>
        )}
        <ul className="tm-list">
          {suppliers.map(({ group, km }) => (
            <li key={group.key} className="tm-contact">
              <button onClick={() => onSupplier(group.name)}>
                <i className="tm-key supplier" />
                <span>
                  <b>{group.name}</b>
                  <small>
                    {km === 0
                      ? "Inside the observed extent"
                      : `${km} km from the observed edge`}{" "}
                    ·{" "}
                    {group.rows.length
                      ? plural(group.rows.length, "open order")
                      : "no open orders"}
                  </small>
                </span>
                <ArrowUpRight size={14} />
              </button>
              <button
                className="btn secondary"
                aria-expanded={draftFor === group.key}
                onClick={() =>
                  draftFor === group.key
                    ? setDraftFor(null)
                    : openDraft(group, km)
                }
              >
                {draftFor === group.key ? "Hide draft" : "Draft a check-in"}
              </button>
              {draftFor === group.key && (
                <div className="tm-draft">
                  <label htmlFor={`draft-${group.key}`} className="sr-only">
                    Check-in message to {group.name}
                  </label>
                  <textarea
                    id={`draft-${group.key}`}
                    ref={draftRef}
                    className="message-editor"
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setCopied(false);
                    }}
                  />
                  <div className="tm-draft-foot">
                    <button className="btn" onClick={() => void copy()}>
                      {copied ? <Check size={15} /> : <Copy size={15} />}
                      {copied ? "Copied" : "Copy message"}
                    </button>
                    <span>Nothing is sent from ExportMate.</span>
                  </div>
                </div>
              )}
            </li>
          ))}
          {sites.map(({ site, km }) => (
            <li key={site.key} className="tm-plain-row">
              <i className="tm-key site" />
              <span>
                <b>{site.name}</b>
                <small>
                  Your site · {km} km from the observed edge. Check stock and
                  road access.
                </small>
              </span>
            </li>
          ))}
        </ul>
      </section>
      {affected.length > 0 && (
        <section className="tm-section">
          <h3>Orders that may be affected</h3>
          <ul className="tm-orders">
            {affected.map((row) => (
              <OrderLine
                key={row.order.id}
                row={row}
                renderStatus={renderStatus}
                onOpen={onOpenOrder}
                note={
                  <span className="status amber">
                    <i />
                    Unconfirmed
                  </span>
                }
              />
            ))}
          </ul>
        </section>
      )}
      <div className="notice tm-caveat">
        <CircleHelp size={18} />
        Satellite shows water on the ground, not damage. It can't tell whether a
        supplier's site, stock or schedule is affected. Confirm with the
        supplier before changing any plan. Order statuses are unchanged.
      </div>
    </>
  );
}

const ROUTE_OPTIONS = [
  { code: "direct", label: "Direct" },
  { code: "SG", label: "Singapore" },
  { code: "MY", label: "Port Klang" },
  { code: "HK", label: "Hong Kong" },
  { code: "AE", label: "Jebel Ali" },
  { code: "LK", label: "Colombo" },
];

function ScenarioPanel({
  rows,
  markets,
  scenario,
  renderStatus,
  onChange,
  onComparison,
  onClose,
  onOpenOrder,
}: {
  rows: Row[];
  markets: MapMarket[];
  scenario: Scenario;
  renderStatus: (order: Order) => React.ReactNode;
  onChange: (scenario: Scenario) => void;
  onComparison: (
    result: { key: string; comparison: MarketComparison } | null,
  ) => void;
  onClose: () => void;
  onOpenOrder: (id: string) => void;
}) {
  const row = rows.find((r) => r.order.id === scenario.orderId) ?? rows[0];
  const [result, setResult] = useState<{
    key: string;
    comparison?: MarketComparison;
    error?: string;
  } | null>(null);
  const requestKey =
    row && scenario.target
      ? JSON.stringify([row.order.id, scenario.mode, scenario.target])
      : "";
  useEffect(() => {
    onComparison(null);
    if (!requestKey) return;
    const [orderId, mode, target] = JSON.parse(requestKey) as [
      string,
      ScenarioMode,
      string,
    ];
    const controller = new AbortController();
    const call =
      mode === "date"
        ? api.compareShipDate(orderId, target, controller.signal)
        : mode === "route"
          ? api.compareRoute(orderId, target, controller.signal)
          : api.compareMarkets(orderId, target, controller.signal);
    call
      .then((comparison) => {
        if (!controller.signal.aborted) {
          setResult({ key: requestKey, comparison });
          onComparison({ key: requestKey, comparison });
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setResult({ key: requestKey, error: errorMessage(e) });
      });
    return () => controller.abort();
  }, [requestKey, onComparison]);
  if (!row) return null;
  const from = row.placement.market;
  const nameOf = (code: string | null) =>
    markets.find((m) => m.code === code)?.name ?? "Unknown market";
  const current = result?.key === requestKey ? result : null;
  const comparison = current?.comparison;
  return (
    <>
      <PanelHead
        eyebrow="WHAT IF"
        title={
          scenario.mode === "date"
            ? "Move the ship date."
            : scenario.mode === "route"
              ? "Change the route."
              : "Compare markets."
        }
        sub={
          scenario.mode === "date"
            ? "See which checklist dates start, stop, or change. This does not estimate an arrival."
            : scenario.mode === "route"
              ? "See what to recheck if the goods stop somewhere else. Cost and sailing time are not in this data."
              : "See which documents carry over, what needs another look, and what the data can't answer yet."
        }
        onBack={onClose}
      />
      <div className="tm-chips" role="group" aria-label="What to compare">
        {(
          [
            ["market", "Market"],
            ["date", "Ship date"],
            ["route", "Route"],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            aria-pressed={scenario.mode === mode}
            className={scenario.mode === mode ? "selected" : ""}
            onClick={() => onChange({ ...scenario, mode, target: null })}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="tm-field" htmlFor="tm-order">
        Order
      </label>
      <select
        id="tm-order"
        className="tm-select"
        value={row.order.id}
        onChange={(e) =>
          onChange({
            orderId: e.target.value,
            mode: scenario.mode,
            target: null,
          })
        }
      >
        {rows.map((r) => (
          <option key={r.order.id} value={r.order.id}>
            {r.order.id} · {r.order.product} → {r.order.destination}
          </option>
        ))}
      </select>
      <div className="tm-current">
        <span>
          <small>NOW</small>
          <b>{nameOf(from)}</b>
          <small>
            {row.order.supplier} → {row.order.destination} · ships{" "}
            {date(row.order.shipDate)} · HS {row.order.hsCode}
          </small>
        </span>
        {renderStatus(row.order)}
      </div>
      {scenario.mode === "market" && (
        <>
          <span className="tm-field">Compare with</span>
          <div
            className="tm-chips"
            role="group"
            aria-label="Market to compare with"
          >
            {markets
              .filter((m) => m.code !== from)
              .map((m) => (
                <button
                  key={m.code}
                  aria-pressed={scenario.target === m.code}
                  className={scenario.target === m.code ? "selected" : ""}
                  onClick={() => onChange({ ...scenario, target: m.code })}
                >
                  {m.name}
                </button>
              ))}
          </div>
          {!scenario.target && (
            <p className="tm-muted">Pick a market here or on the map.</p>
          )}
        </>
      )}
      {scenario.mode === "date" && (
        <>
          <label className="tm-field" htmlFor="tm-ship-date">
            Proposed ship date
          </label>
          <input
            id="tm-ship-date"
            className="tm-select"
            type="date"
            value={scenario.target ?? ""}
            onChange={(e) =>
              onChange({ ...scenario, target: e.target.value || null })
            }
          />
          {!scenario.target && (
            <p className="tm-muted">
              Planned date is {date(row.order.shipDate)}. Pick another day.
            </p>
          )}
        </>
      )}
      {scenario.mode === "route" && (
        <>
          <span className="tm-field">Route via</span>
          <div className="tm-chips" role="group" aria-label="Route to compare">
            {ROUTE_OPTIONS.map((stop) => (
              <button
                key={stop.code}
                aria-pressed={scenario.target === stop.code}
                className={scenario.target === stop.code ? "selected" : ""}
                onClick={() => onChange({ ...scenario, target: stop.code })}
              >
                {stop.label}
              </button>
            ))}
          </div>
          {!scenario.target && (
            <p className="tm-muted">
              Pick a direct routing or an intermediate stop.
            </p>
          )}
        </>
      )}
      <div className="notice tm-caveat">
        <CircleHelp size={18} />
        {scenario.mode === "date"
          ? "Moving the ship date does not change the destination or the documents on file."
          : scenario.mode === "route"
            ? "A different stop does not price the freight or promise a transit time."
            : "Changing market still depends on your customer, the contract and whether you can actually sell there. This compares paperwork only."}
      </div>
      {scenario.target && !current && (
        <p className="tm-muted" role="status">
          <Loader2 size={14} /> Comparing…
        </p>
      )}
      {current?.error && (
        <p className="tm-muted" role="alert">
          {current.error}
        </p>
      )}
      {comparison && (
        <>
          <section className="tm-section tm-compare reuse">
            <h3>
              <Check size={16} /> On file for review{" "}
              <span>{comparison.reuse.length}</span>
            </h3>
            {!comparison.reuse.length && (
              <p className="tm-muted">
                No matching supplier evidence is on file.
              </p>
            )}
            <ul>
              {comparison.reuse.map((item) => (
                <li key={item.title}>
                  <b>{item.title}</b>
                  <p>{item.note}</p>
                </li>
              ))}
            </ul>
          </section>
          <section className="tm-section tm-compare review">
            <h3>
              <ArrowLeftRight size={16} /> Re-evaluate{" "}
              <span>{comparison.reevaluate.length}</span>
            </h3>
            <ul>
              {comparison.reevaluate.map((item) => (
                <li key={item.title}>
                  <b>
                    {item.title}
                    {item.tag && <em>{item.tag}</em>}
                  </b>
                  <p>{item.note}</p>
                </li>
              ))}
            </ul>
            {comparison.dropped.length > 0 && (
              <p className="fine-print">
                Not listed in the current {nameOf(comparison.toMarket)}{" "}
                checklist: {comparison.dropped.join(", ")}.
              </p>
            )}
          </section>
          <section className="tm-section tm-compare unknown">
            <h3>
              <CircleHelp size={16} /> Not enough information{" "}
              <span>{comparison.unknown.length}</span>
            </h3>
            <ul>
              {comparison.unknown.map((item) => (
                <li key={item.title}>
                  <b>{item.title}</b>
                  <p>{item.note}</p>
                </li>
              ))}
            </ul>
          </section>
          {!!comparison.assumptions?.length && (
            <ul className="fine-print">
              {comparison.assumptions.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <p className="fine-print">
            Based on the market checklists and the documents on file for{" "}
            {row.order.supplier}. Illustrative, not legal guidance.
          </p>
        </>
      )}
      <button className="text-link" onClick={() => onOpenOrder(row.order.id)}>
        Open {row.order.id} <ArrowUpRight size={14} />
      </button>
    </>
  );
}
