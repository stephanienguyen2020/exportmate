import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ArrowUpRight,
  Layers,
  Loader2,
  Route,
  Satellite,
  ShieldCheck,
} from "lucide-react";
import { type Order } from "./data";
import {
  api,
  asOrder,
  type MarketComparison,
  type SatelliteObservation,
  type TradeMap,
} from "./api";
import { errorMessage } from "./auth";
import { useImpacts } from "../ai/news/NewsWatch";
import { FloodPanel } from "./trade-map/FloodPanel";
import { MapCanvas } from "./trade-map/MapCanvas";
import { SitePanel, SupplierPanel } from "./trade-map/PlacePanels";
import { ScenarioPanel } from "./trade-map/ScenarioPanel";
import { SiteForm, SupplierForm } from "./trade-map/forms";
import {
  type Editing,
  type FloodEntry,
  type Focus,
  type LonLat,
  MARKET_VIEWS,
  type Marker,
  type MarketSummary,
  PROFILE_ORIGIN_AT,
  type Pin,
  type Row,
  type Scenario,
  type Selection,
  type SupplierGroup,
  type Tone,
  type View,
  type ViewId,
  WORLD_VIEW,
  floodView,
  isGap,
  lonLat,
  productionView,
  supplierKey,
  worst,
} from "./trade-map/model";
import { MarketPanel, OverviewPanel } from "./trade-map/panels";
import "./trade-map.css";

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
      onCertificate={
        editable
          ? (name) => finishEditing({ kind: "supplier", name })
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
