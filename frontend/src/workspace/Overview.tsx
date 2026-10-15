import { Fragment } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  CircleAlert,
  Globe2,
  Leaf,
  Package,
  ShieldCheck,
} from "lucide-react";
import {
  date,
  daysUntil,
  makerCost,
  money,
  placeName,
  sampleCosts,
  sampleObligation,
  sampleSources,
} from "../data";
import { placeCode, routeStops } from "../account-store";
import ErrorBoundary from "../ErrorBoundary";
import { NewsHighlights } from "../../ai/news/NewsWatch";
import { OrderTable } from "./OrderTable";
import { valueAtRisk, type Workspace } from "./store";
import { Button, go, listNames, orderPath, plural } from "./ui";

export default function Overview({
  ws,
  buyer,
  startDemo,
  showOrders,
}: {
  ws: Workspace;
  buyer: boolean;
  startDemo: () => void;
  showOrders: (filter: string) => void;
}) {
  const { live, orders, overview, exposed, profile } = ws;
  const clearOrders = orders.filter(ws.isClear);
  const pendingOrders = orders.filter(ws.isPending);
  const risk = valueAtRisk(ws, buyer);
  // The demo's soonest affected shipment still ahead (or the latest one, if all have sailed).
  const upcoming = [...exposed].sort((a, b) =>
    a.shipDate.localeCompare(b.shipDate),
  );
  const nextExposed =
    upcoming.find((o) => daysUntil(o.shipDate) >= 0) || upcoming.at(-1);
  const exposedSuppliers = [...new Set(exposed.map((o) => o.supplier))];
  const now = new Date();
  const todayLabel =
    `${now.toLocaleDateString("en-GB", { weekday: "long" })}, ${now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`.toUpperCase();
  return (
    <>
      <div className="eyebrow greeting">
        <span>YOUR TRADE, IN THE CLEAR.</span>
        <span>
          {todayLabel}
          {!live && <span className="muted"> · SAMPLE DATA</span>}
        </span>
      </div>
      <section className="hero-heading">
        <div>
          <h1>
            YOUR TRADE.
            <br />
            <b>AT A GLANCE.</b>
          </h1>
        </div>
        <div className="hero-copy">
          <p>Order risks. Clear next steps.</p>
          {live && (
            <button className="text-link" onClick={() => go("reports")}>
              Company report <ArrowUpRight size={18} />
            </button>
          )}
          <button className="text-link" onClick={startDemo}>
            {live ? "Analyse orders" : "Run demo"} <ArrowUpRight size={18} />
          </button>
        </div>
      </section>
      <section className="port-hero">
        <img
          src="/port.jpg"
          alt="Shipping containers and cranes at an international cargo port"
        />
        <div className="port-overlay" />
        <div className="port-top">
          <span>
            <i className="live-dot" /> YOUR CORRIDOR. CONNECTED.
          </span>
          <span className="image-label">01 / GLOBAL TRADE</span>
        </div>
        <div className="port-bottom">
          <div>
            <div className="corridor">
              {routeStops(profile).map((place, i) => (
                <Fragment key={i}>
                  {i > 0 && <ArrowRight />}
                  <span>{place}</span>
                </Fragment>
              ))}
            </div>
            <p>Your first trade corridor.</p>
          </div>
          {/* The map reads company data from the backend; the demo has none to map. */}
          <button
            onClick={() => go(live ? "map" : "orders")}
            className="port-button"
          >
            {live ? "Explore your corridor" : "See your corridor's orders"}{" "}
            <ArrowUpRight size={18} />
          </button>
        </div>
      </section>
      <section className="metrics">
        <div>
          <span className="metric-label">
            OPEN ORDERS <Package size={15} />
          </span>
          <div className="metric-value">
            {String(
              live ? (overview?.totalOrders ?? orders.length) : orders.length,
            ).padStart(2, "0")}
            <span>across your corridor</span>
          </div>
          <div className="metric-note">
            <i className="dot green-dot" />
            {clearOrders.length} in the clear
            {pendingOrders.length > 0
              ? ` · ${pendingOrders.length} awaiting analysis`
              : ""}
          </div>
        </div>
        <div>
          <span className="metric-label">
            NEED YOUR ATTENTION <CircleAlert size={15} />
          </span>
          <div className="metric-value danger">
            {String(exposed.length).padStart(2, "0")}
            <span>orders affected</span>
          </div>
          <div className="metric-note">
            {live
              ? `${overview?.countsByStatus.needs_data || 0} orders need more data`
              : exposed.length
                ? `Missing ${sampleObligation.requirement} records. A clear next step.`
                : "You’re all clear for now."}
          </div>
        </div>
        <div>
          <span className="metric-label">
            {live ? "EXPOSED ORDER VALUE" : "ESTIMATED VALUE AT RISK"}{" "}
            <ArrowUpRight size={15} />
          </span>
          <div className="metric-value">
            {risk.display}
            <span>{live ? "by currency" : risk.currency}</span>
          </div>
          <div className="metric-note">
            {live
              ? "Full order values; not estimated extra costs"
              : buyer
                ? `Buyer margin exposure · ${plural(exposed.length, "order")} × ${money(sampleCosts.buyer.margin, sampleCosts.buyer.currency)}`
                : `Documentation & delay costs · ${plural(exposed.length, "order")} × ${money(makerCost, sampleCosts.maker.currency)}`}
          </div>
        </div>
        <div>
          <span className="metric-label">
            NEXT AFFECTED SHIPMENT <Globe2 size={15} />
          </span>
          <div className="metric-value">
            {live
              ? overview?.nearestAffectedShipDate
                ? date(overview.nearestAffectedShipDate)
                : "—"
              : nextExposed
                ? Math.abs(daysUntil(nextExposed.shipDate))
                : "—"}
            <span>
              {live
                ? "next affected ship date"
                : !nextExposed
                  ? "no action needed"
                  : daysUntil(nextExposed.shipDate) >= 0
                    ? daysUntil(nextExposed.shipDate) === 1
                      ? "day to prepare"
                      : "days to prepare"
                    : "days since it shipped"}
            </span>
          </div>
          <div className="metric-note">
            {live
              ? "Reported by your workspace"
              : nextExposed
                ? `${date(nextExposed.shipDate)} · ${placeName(nextExposed.destination)} · ${nextExposed.id}`
                : "No exposed shipments in this scenario"}
          </div>
        </div>
      </section>
      <div className="section-heading">
        <div>
          <span className="eyebrow">PRIORITY ACTIONS</span>
          <h2>Your next move.</h2>
        </div>
        <button
          className="text-link"
          onClick={() => showOrders("Action needed")}
        >
          View all alerts <ArrowUpRight size={16} />
        </button>
      </div>
      <div className="overview-grid">
        <section className="action-card">
          <div className="action-top">
            <span className={`status ${exposed.length ? "red" : "green"}`}>
              <i />
              {exposed.length ? "ACTION NEEDED" : "ALL CLEAR"}
            </span>
            <span className="mono muted">
              {live
                ? routeStops(profile).map(placeCode).join(" · ")
                : `${sampleObligation.market} · WOOD PRODUCTS`}
            </span>
          </div>
          <h3>
            {live
              ? exposed.length
                ? "Review affected orders."
                : pendingOrders.length
                  ? "Orders awaiting analysis."
                  : "Your order status."
              : exposed.length
                ? sampleObligation.short
                : "Your orders are looking good."}
          </h3>
          <p>
            {live
              ? "Analyse your orders from the Orders page to check each one against its market checklist, your cost settings and your playbook. Each order's page shows what was found."
              : exposed.length
                ? `${listNames(exposedSuppliers)} must provide ${sampleObligation.requirement} records for ${plural(exposed.length, "EU-bound order")}.`
                : "Run the sample rule change to see how ExportMate connects a new obligation to your open orders."}
          </p>
          <div className="order-tags">
            {exposed.slice(0, 2).map((o) => (
              <button key={o.id} onClick={() => go(orderPath(o.id))}>
                {o.id}
                <ArrowUpRight size={12} />
              </button>
            ))}
            {exposed.length > 0 && <span>{risk.display} at risk</span>}
          </div>
          <div className="action-footer">
            <span>
              <ShieldCheck size={16} />{" "}
              {live
                ? "Server-backed order status"
                : "Evidence linked · sample scenario"}
            </span>
            <Button
              onClick={() =>
                exposed.length
                  ? go(orderPath(exposed[0].id))
                  : live
                    ? go("orders")
                    : startDemo()
              }
            >
              {exposed.length
                ? "Review impact"
                : live
                  ? "View orders"
                  : "Run the demo"}
              <ArrowUpRight size={16} />
            </Button>
          </div>
        </section>
        <section className="quiet-card">
          <div className="quiet-icon">
            <Leaf size={26} />
          </div>
          <span className="eyebrow">RULE COVERAGE</span>
          <h3>
            Your corridor,
            <br />
            monitored.
          </h3>
          <p>Only changes that touch your business make it to your desk.</p>
          <div className="coverage">
            <span>
              <i className="pulse" />
              {live
                ? "Official texts behind your market checklists"
                : `${sampleSources.length} sample source collections`}
            </span>
            <button className="text-link" onClick={() => go("rules")}>
              Rule watch <ArrowUpRight size={15} />
            </button>
          </div>
        </section>
      </div>
      <ErrorBoundary fallback={null}>
        <NewsHighlights live={live} />
      </ErrorBoundary>
      <div className="section-heading order-section">
        <h2>Orders on the move.</h2>
        <button className="text-link" onClick={() => go("orders")}>
          All {orders.length} orders <ArrowUpRight size={16} />
        </button>
      </div>
      <OrderTable items={orders.slice(0, 4)} ws={ws} />
    </>
  );
}
