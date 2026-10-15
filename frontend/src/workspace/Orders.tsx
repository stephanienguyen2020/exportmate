import { lazy, Suspense } from "react";
import { Plus, Search } from "lucide-react";
import { OrderTable } from "./OrderTable";
import { valueAtRisk, type Workspace } from "./store";
import { Button, PageHeading, go, type Notify } from "./ui";

const RunPanel = lazy(() =>
  import("../Analysis").then((m) => ({ default: m.RunPanel })),
);

// Filter and search are kept by the shell, so they survive a visit to an order.
export type OrderFilter = { filter: string; search: string };

export default function Orders({
  ws,
  buyer,
  view,
  onView,
  notify,
}: {
  ws: Workspace;
  buyer: boolean;
  view: OrderFilter;
  onView: (view: OrderFilter) => void;
  notify: Notify;
}) {
  const { live, orders, exposed } = ws;
  const { filter, search } = view;
  const matches = orders.filter(
    (o) =>
      (filter === "All orders" ||
        (filter === "Action needed"
          ? o.risk
          : filter === "Awaiting analysis"
            ? ws.isPending(o)
            : filter === "Needs data"
              ? o.status === "needs_data"
              : ws.isClear(o))) &&
      `${o.id} ${o.product} ${o.supplier} ${o.destination}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeading
        label="EVERY ORDER. A CLEARER PICTURE."
        title="Your orders."
        description="Track orders and exposure."
        action={
          <Button onClick={() => go("data")}>
            <Plus size={17} />
            Import orders
          </Button>
        }
      />
      {live && (
        <Suspense fallback={null}>
          <RunPanel
            editable={ws.editable}
            pending={orders.filter(ws.isPending).length}
            onFinished={ws.refreshOrders}
            notify={notify}
          />
        </Suspense>
      )}
      <div className="summary-strip">
        <span>
          <b>{orders.length}</b> open orders
        </span>
        <span>
          <b className="danger">{exposed.length}</b> need attention
        </span>
        <span>
          <b>{valueAtRisk(ws, buyer).display}</b>{" "}
          {live ? "exposed order value" : "estimated at risk"}
        </span>
      </div>
      <div className="toolbar">
        <div className="tabs">
          {[
            "All orders",
            "Action needed",
            "In the clear",
            ...(live ? ["Awaiting analysis", "Needs data"] : []),
          ].map((f) => (
            <button
              key={f}
              className={filter === f ? "selected" : ""}
              aria-pressed={filter === f}
              onClick={() => onView({ ...view, filter: f })}
            >
              {f}
            </button>
          ))}
        </div>
        <label className="search">
          <Search size={17} />
          <input
            aria-label="Search orders"
            placeholder="Search orders, suppliers…"
            value={search}
            onChange={(e) => onView({ ...view, search: e.target.value })}
          />
        </label>
      </div>
      <OrderTable items={matches} ws={ws} />
    </>
  );
}
