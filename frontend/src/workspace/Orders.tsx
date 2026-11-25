import { lazy, Suspense, useState } from "react";
import { Plus, Search } from "lucide-react";
import { OrderTable } from "./OrderTable";
import { ALL_ORDERS, valueAtRisk, type Workspace } from "./store";
import { Button, PageHeading, go, type Notify } from "./ui";

const RunPanel = lazy(() =>
  import("../Analysis").then((m) => ({ default: m.RunPanel })),
);
const BulkStatusBar = lazy(() =>
  import("../OrderStatus").then((m) => ({ default: m.BulkStatusBar })),
);

// Filter and search are kept by the shell, so they survive a visit to an order. `filter` is
// ALL_ORDERS or an order status code.
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
  const { live, orders, exposed, statusOptions } = ws;
  const { filter, search } = view;
  // Orders ticked for one status change (owners and editors of a signed-in company); only
  // the ticked ones the filter and search still show are changed.
  const [picked, setPicked] = useState<string[]>([]);
  const canPick = live && ws.editable && statusOptions.some((s) => s.manual);
  // A tab per status the database lists (retired ones aside). The demo's orders are only ever
  // exposed or clear, so it shows the statuses its orders have.
  const shown = new Set(orders.map((o) => o.status));
  const tabs = [
    { code: ALL_ORDERS, label: "All orders" },
    ...(statusOptions.length
      ? statusOptions.filter((s) => !s.retired && (live || shown.has(s.code)))
      : [...shown].filter(Boolean).map((code) => ({ code, label: ws.statusLabel(code) }))),
  ];
  const matches = orders.filter(
    (o) =>
      (filter === ALL_ORDERS || o.status === filter) &&
      `${o.id} ${o.product} ${o.supplier} ${o.destination}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const pickedShown = matches
    .filter((o) => picked.includes(o.id))
    .map((o) => o.id);
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
            lastRun={ws.importRun}
            onFinished={ws.refreshOrders}
            statusLabel={ws.statusLabel}
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
          {tabs.map((t) => (
            <button
              key={t.code}
              className={filter === t.code ? "selected" : ""}
              aria-pressed={filter === t.code}
              onClick={() => onView({ ...view, filter: t.code! })}
            >
              {t.label}
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
      {canPick && pickedShown.length > 0 && (
        <Suspense fallback={null}>
          <BulkStatusBar
            ids={pickedShown}
            options={statusOptions}
            notify={notify}
            onChanged={async () => {
              setPicked([]);
              await ws.refreshOrders();
            }}
            onClear={() => setPicked([])}
          />
        </Suspense>
      )}
      <OrderTable
        items={matches}
        ws={ws}
        picked={picked}
        onPick={canPick ? setPicked : undefined}
      />
    </>
  );
}
