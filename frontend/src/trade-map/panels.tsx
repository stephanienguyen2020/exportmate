import React from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  CircleHelp,
  Plus,
  Satellite,
} from "lucide-react";
import { date, money, type Order } from "../data";
import {
  type MapMarket,
  type MapSite,
  type RequirementCheck,
  type SatelliteObservation,
} from "../api";
import { type Impact } from "../../ai/news/NewsWatch";
import { RegulationCitation } from "../Regulations";
import {
  type FloodEntry,
  type MarketSummary,
  type Row,
  type SupplierGroup,
  type Tone,
  byShipDate,
  marketTerms,
  plural,
  productKey,
  supplierKey,
} from "./model";

export function PanelHead({
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

export function OrderLine({
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

export function FloodCallout({
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

export function OverviewPanel({
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

export function MarketPanel({
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
