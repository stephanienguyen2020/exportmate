import React, { useEffect, useMemo, useRef, useState } from "react";
import { geoCircle, geoContains, geoGraticule10, geoPath } from "d3-geo";
import { MapPin, Waves } from "lucide-react";
import { date, type Order } from "../data";
import { type MapMarket, type MarketComparison, type TradeMap } from "../api";
import TradeMapGlobe, {
  type GlobePoint,
  type GlobeRoute,
} from "../TradeMapGlobe";
import {
  type Atlas,
  H,
  type LabelSide,
  type LonLat,
  type Marker,
  type MarketSummary,
  PROFILE_HOME_ID,
  type Row,
  type Scenario,
  type SupplierGroup,
  type Tone,
  type View,
  W,
  arcPath,
  forD3,
  loadAtlas,
  lonLat,
  pct,
  plural,
  projectionFor,
  routeStart,
  worst,
} from "./model";

export function MapCanvas({
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
