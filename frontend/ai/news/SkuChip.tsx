import React, { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { date, isoDay, type Order } from "../../src/data";
import { hsHeading, suggestOrders, type StockItem } from "./news-matches";

type Affected = { sku: string; name: string; reason: string };

const orderLink = (id: string) => "#/workspace/orders/" + encodeURIComponent(id);

/** Open orders this stock item points to, by the same rule as an alert's suggested orders
 * (HS heading and market), less those a person marked not relevant to the alert. */
export function ordersForItem(entry: Affected, item: StockItem | undefined, orders: Order[], rejected: Set<string>) {
  if (!item) return [];
  const today = isoDay();
  const open = orders.filter((o) => o.shipDate >= today && !rejected.has(o.id));
  return suggestOrders({ id: "", headline: "", affected: [entry] }, new Map([[item.sku, item]]), open);
}

/** A stock item named in an alert: a link to its one matching order, or a list of them. */
export function SkuChip({
  entry,
  item,
  orders,
  rejected,
  error,
}: {
  entry: Affected;
  item?: StockItem;
  orders: Order[] | null;
  rejected: Set<string>;
  // Why orders can't be matched (stock or orders didn't load).
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const found = orders ? ordersForItem(entry, item, orders, rejected) : [];
  const heading = hsHeading(item?.hsCode);
  const markets = (item?.markets || []).filter((m) => /^[A-Z]{2}$/.test(m));
  if (found.length === 1) {
    const { order, reason } = found[0];
    return (
      <a className="news-sku" href={orderLink(order.id)} title={`${entry.name}: open ${order.id}. ${reason}`}>
        {entry.sku} <ArrowUpRight size={10} />
      </a>
    );
  }
  const loading = !orders || !item;
  return (
    <span className="news-sku-wrap" ref={box}>
      <button
        ref={button}
        type="button"
        className="news-sku"
        aria-expanded={open}
        aria-label={`${entry.sku}: ${found.length ? `${found.length} matching orders` : "show matching orders"}`}
        title={`${entry.name}: ${entry.reason}`}
        onClick={() => setOpen(!open)}
      >
        {entry.sku}
        {found.length > 1 && <em>{found.length}</em>}
      </button>
      {open && (
        <div className="news-sku-pop" role="dialog" aria-label={`Orders for ${entry.sku}`}>
          <strong>
            {entry.sku} · {entry.name}
          </strong>
          {item && (
            <small>
              HS {heading || item.hsCode || "—"}
              {markets.length ? ` · sells to ${markets.join(", ")}` : ""}
            </small>
          )}
          {found.length ? (
            <ul>
              {found.map(({ order }) => (
                <li key={order.id}>
                  <a href={orderLink(order.id)}>
                    <b>{order.id}</b>
                    <span>
                      {order.product} · {order.destination} · ships {date(order.shipDate)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              {error
                ? error
                : loading
                  ? "Loading orders…"
                  : `No open order has HS heading ${heading || "—"}${
                      markets.length ? ` and ships to ${markets.join(" or ")}` : ""
                    }.`}
            </p>
          )}
          <a className="text-link" href="#/workspace/orders">
            All orders <ArrowUpRight size={13} />
          </a>
        </div>
      )}
    </span>
  );
}
