import React, { lazy, Suspense, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ClipboardList,
  FileText,
  Map as MapIcon,
  Send,
  ShieldCheck,
} from "lucide-react";
import {
  date,
  makerCost,
  money,
  sampleCostWhy,
  sampleCosts,
  sampleGap,
  sampleObligation,
  type Order,
} from "../data";
import { api, asOrder, type OrderDetail } from "../api";
import { errorMessage } from "../auth";
import { CostWhy } from "../CostWhy";
import { OrderStatus } from "./OrderTable";
import type { Workspace } from "./store";
import { Button, PageHeading, go, orderPath, type Notify } from "./ui";

const OrderAnalysis = lazy(() => import("../Analysis"));
const OrderStatusPanel = lazy(() => import("../OrderStatus"));
const costMoney = (n: number) => money(n, sampleCosts.maker.currency);

function OrderHeading({ order, ws }: { order: Order; ws: Workspace }) {
  return (
    <>
      <button className="text-link back" onClick={() => go("orders")}>
        <ArrowLeft size={16} />
        All orders
      </button>
      <PageHeading
        label={
          ws.live
            ? "ORDER DETAIL / YOUR COMPANY DATA"
            : "ORDER IMPACT / SAMPLE ANALYSIS"
        }
        title={order.id + "."}
        description={order.product + " · " + order.destination}
        action={<OrderStatus order={order} ws={ws} />}
      />
      <div className="detail-meta">
        <div>
          <small>SUPPLIER</small>
          <b>{order.supplier}</b>
        </div>
        <div>
          <small>SHIP DATE</small>
          <b>
            {date(order.shipDate)} {order.shipDate.slice(0, 4)}
          </b>
        </div>
        <div>
          <small>ORDER VALUE</small>
          <b>{money(order.value, order.currency)}</b>
        </div>
        <div>
          <small>HS CODE</small>
          <b>{order.hsCode}</b>
        </div>
      </div>
    </>
  );
}

// A signed-in company's order: its latest analysis, report and source row.
export function CompanyOrder({
  id,
  ws,
  notify,
}: {
  id: string;
  ws: Workspace;
  notify: Notify;
}) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api
      .detail(id)
      .then((value) => active && setDetail(value))
      .catch((e) => active && setError(errorMessage(e)));
    return () => {
      active = false;
    };
  }, [id]);
  if (!detail) return <p role="status">{error || "Loading order…"}</p>;
  const order = asOrder(detail.order);
  const prepareReport = () =>
    ws.mutate(async () => {
      const draft = await api.createReport({ kind: "order", orderId: order.id });
      go("reports/" + encodeURIComponent(draft.id));
    });
  return (
    <>
      <OrderHeading order={order} ws={ws} />
      <button
        className="text-link order-map-link"
        onClick={() => go("map/order/" + encodeURIComponent(order.id))}
      >
        <MapIcon size={15} />
        If this order went to another market, what would change?
        <ArrowUpRight size={15} />
      </button>
      <section className="panel report-actions">
        <div>
          <h2>Compliance report</h2>
          <p>
            This order, the document checklist for its market with the official
            text behind each line, and the CSV row it came from. Preview and
            edit it before you download or email the PDF.
          </p>
        </div>
        <div className="report-buttons">
          <Button disabled={ws.busy} onClick={() => void prepareReport()}>
            <ClipboardList size={16} />
            Prepare report
          </Button>
        </div>
      </section>
      <Suspense
        fallback={
          <section className="panel" role="status">
            Loading the status…
          </section>
        }
      >
        <OrderStatusPanel
          key={detail.order.id}
          detail={detail}
          options={ws.statusOptions}
          role={ws.account?.role ?? null}
          notify={notify}
          onChanged={async (next) => {
            // Only if the visitor is still on this order.
            if (location.hash.endsWith("/" + orderPath(next.order.id)))
              setDetail(next);
            await ws.refreshOrders();
          }}
        />
      </Suspense>
      <Suspense
        fallback={
          <section className="panel" role="status">
            Loading the analysis…
          </section>
        }
      >
        <OrderAnalysis
          key={detail.order.id}
          orderId={detail.order.id}
          hsCode={detail.order.hsCode}
          latestReportId={detail.latestReportId ?? null}
          role={ws.account?.role ?? null}
          notify={notify}
          onChanged={async () => {
            const orderId = detail.order.id;
            const [next] = await Promise.all([
              api.detail(orderId),
              ws.refreshOrders(),
            ]);
            // Only if the visitor is still on this order.
            if (location.hash.endsWith("/" + orderPath(orderId)))
              setDetail(next);
          }}
        />
      </Suspense>
      <section className="panel">
        <h2>Source</h2>
        <p>
          The document checklist for this order's market is also on the trade
          map, and the compliance report above collects it with the official
          texts to share.
        </p>
        {detail.source ? (
          <>
            <h3>Original CSV row</h3>
            <p>
              Import {detail.source.importId} · row {detail.source.rowNumber}
            </p>
            <dl className="evidence-data">
              {Object.entries(detail.source.raw).map(([key, value]) => (
                <React.Fragment key={key}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </React.Fragment>
              ))}
            </dl>
          </>
        ) : (
          <p>No source CSV row is attached to this order.</p>
        )}
      </section>
    </>
  );
}

// A demo order, checked against the one sample rule change.
export function SampleOrder({
  order,
  ws,
  buyer,
  onMessage,
  onEvidence,
}: {
  order: Order;
  ws: Workspace;
  buyer: boolean;
  onMessage: (order: Order) => void;
  onEvidence: (order: Order) => void;
}) {
  const sent = ws.sent.includes(order.id);
  return (
    <>
      <OrderHeading order={order} ws={ws} />
      {order.risk ? (
        <div className="detail-grid">
          <section className="panel">
            <span className="eyebrow danger">01 / WHAT CHANGED</span>
            <h2>
              A documentation gap.
              <br />
              An actionable next step.
            </h2>
            <p>
              The sample obligation requires {sampleObligation.requirement} for{" "}
              {sampleObligation.materials.join(", ")} and HS{" "}
              {sampleObligation.hsPrefixes.join(", ")} wood products bound for
              the {sampleObligation.marketName}. {sampleGap(order)}
            </p>
            <button className="evidence-link" onClick={() => onEvidence(order)}>
              <FileText size={19} />
              <span>
                Review the source & your data
                <small>
                  {sampleObligation.clause} · orders.csv / {order.id}
                </small>
              </span>
              <ArrowUpRight size={18} />
            </button>
            <h3>The cost of waiting</h3>
            <div className="cost-row">
              <span>Documentation preparation</span>
              <b>
                <CostWhy why={sampleCostWhy.documentation}>
                  {costMoney(sampleCosts.maker.documentation)}
                </CostWhy>
              </b>
            </div>
            <div className="cost-row">
              <span>
                Potential delay · {sampleCosts.maker.delayDays} days ×{" "}
                {costMoney(sampleCosts.maker.delayPerDay)}
              </span>
              <b>
                <CostWhy why={sampleCostWhy.delay}>
                  {costMoney(
                    sampleCosts.maker.delayDays * sampleCosts.maker.delayPerDay,
                  )}
                </CostWhy>
              </b>
            </div>
            <div className="cost-row total">
              <span>Estimated maker exposure</span>
              <b>
                <CostWhy why={`The two lines above. ${sampleCostWhy.note}`}>
                  {costMoney(makerCost)} {sampleCosts.maker.currency}
                </CostWhy>
              </b>
            </div>
            <p className="fine-print">
              Illustrative estimate from the demo's cost assumptions, not a
              tariff or guaranteed cost; hover an amount to see where it comes
              from. Order value is not added to this estimate.
            </p>
            {buyer && (
              <div className="notice">
                Buyer scenario:{" "}
                <CostWhy why={sampleCostWhy.margin}>
                  {money(sampleCosts.buyer.margin, sampleCosts.buyer.currency)}
                </CostWhy>{" "}
                margin exposure per affected purchase order. This is a separate
                sample estimate, not a currency conversion.
              </div>
            )}
            <h3>How we got here</h3>
            <div className="trace-inline">
              {["Relevance", "Exposure", "Cost", "Plan", "Auditor"].map((s) => (
                <span key={s}>
                  <Check size={13} />
                  {s}
                </span>
              ))}
            </div>
            <p className="fine-print">
              Simulated reasoning. An unsupported alternative-supplier claim was
              rejected by the auditor and removed.
            </p>
          </section>
          <aside className="recommendation">
            <span className="eyebrow">02 / YOUR NEXT MOVE</span>
            <div className="quiet-icon">
              <Send size={24} />
            </div>
            <h2>
              Start with <br />
              your supplier.
            </h2>
            <p>
              Request plot-level geolocation and supporting origin records from{" "}
              {order.supplier}.
            </p>
            <div className="recommendation-meta">
              <span>Suggested owner</span>
              <b>{ws.profile.name}</b>
              <span>Priority</span>
              <b>Before shipment</b>
              <span>Channel</span>
              <b>Zalo · demo</b>
            </div>
            <Button onClick={() => onMessage(order)}>
              {sent ? "Review message again" : "Review supplier message"}
              <ArrowUpRight size={17} />
            </Button>
            {sent && (
              <p className="sent-note">
                <CheckCheck size={16} />
                Message confirmed in demo
              </p>
            )}
            <p className="fine-print">
              You review and confirm every action. A message request does not
              clear the underlying risk.
            </p>
          </aside>
        </div>
      ) : (
        <section className="panel clear-panel">
          <ShieldCheck size={44} />
          <h2>In the clear.</h2>
          <p>
            The sample rule change ({sampleObligation.title}) doesn't apply to
            this order, or its supplier's records cover it. The demo checks
            only that one rule.
          </p>
          <Button onClick={() => go("orders")}>
            Back to orders
            <ArrowRight size={16} />
          </Button>
        </section>
      )}
    </>
  );
}
