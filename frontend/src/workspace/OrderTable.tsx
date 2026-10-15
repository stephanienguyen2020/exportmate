import { ArrowUpRight } from "lucide-react";
import { date, money, type Order } from "../data";
import type { Workspace } from "./store";
import { go, orderPath } from "./ui";

export function OrderStatus({ order, ws }: { order: Order; ws: Workspace }) {
  const option = ws.statusOption(order.status);
  return (
    <span className={`status ${option ? option.tone : ws.tone(order)}`}>
      <i />
      {option
        ? option.label
        : order.risk
          ? "Action needed"
          : ws.isClear(order)
            ? "In the clear"
            : order.status === "needs_data"
              ? "Needs data"
              : "Awaiting analysis"}
    </span>
  );
}

// With `onPick`, each row gets a tick and the header ticks every order listed; `picked` are
// the ticked order ids.
export function OrderTable({
  items,
  ws,
  picked = [],
  onPick,
}: {
  items: Order[];
  ws: Workspace;
  picked?: string[];
  onPick?: (ids: string[]) => void;
}) {
  const all = items.length > 0 && items.every((o) => picked.includes(o.id));
  const some = items.some((o) => picked.includes(o.id));
  return (
    <div className="table-scroll">
      <table className={"orders-table" + (onPick ? " pickable" : "")}>
        <thead>
          <tr>
            {onPick && (
              <th className="order-pick">
                {/* Phones hide the header row but keep this cell, labelled, above the cards. */}
                <input
                  type="checkbox"
                  aria-label="Select every order shown"
                  checked={all}
                  ref={(box) => {
                    if (box) box.indeterminate = some && !all;
                  }}
                  onChange={(e) => {
                    const ids = items.map((o) => o.id);
                    onPick(
                      e.target.checked
                        ? [...new Set([...picked, ...ids])]
                        : picked.filter((id) => !ids.includes(id)),
                    );
                  }}
                />
                <span aria-hidden="true">Select all shown</span>
              </th>
            )}
            <th>Order / product</th>
            <th>Supplier</th>
            <th>Destination</th>
            <th>Order value</th>
            <th>Ships</th>
            <th>Status</th>
            <th>
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.id}>
              {onPick && (
                <td className="order-pick">
                  <input
                    type="checkbox"
                    aria-label={`Select ${o.id}`}
                    checked={picked.includes(o.id)}
                    onChange={(e) =>
                      onPick(
                        e.target.checked
                          ? [...picked, o.id]
                          : picked.filter((id) => id !== o.id),
                      )
                    }
                  />
                </td>
              )}
              <td>
                <button className="order-link" onClick={() => go(orderPath(o.id))}>
                  {o.id}
                </button>
                <small>{o.product}</small>
              </td>
              <td data-label="Supplier">{o.supplier}</td>
              <td data-label="Destination">{o.destination}</td>
              <td data-label="Order value" className="mono">
                {money(o.value, o.currency)}
              </td>
              <td data-label="Ships">{date(o.shipDate)}</td>
              <td data-label="Status">
                <OrderStatus order={o} ws={ws} />
              </td>
              <td className="order-open">
                <button
                  className="icon-btn"
                  aria-label={`View ${o.id}`}
                  onClick={() => go(orderPath(o.id))}
                >
                  <ArrowUpRight size={18} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && (
        <div className="empty">
          No orders match your search. Try another order, supplier, or
          destination.
        </div>
      )}
    </div>
  );
}
