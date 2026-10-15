// An order's facts on its page, and (owners and editors, and every demo visitor) a change to
// them or the order's removal. Signed in, the backend saves a change, audits it and analyses
// the order again (PATCH /orders/{id}), or removes the order with its history and reports
// (DELETE /orders/{id}); the demo checks a change against the sample rule change. The fields
// follow the same rules as a CSV row. The order ID never changes: reports, solutions and the
// activity log name the order by it.
import { useState, type FormEvent } from "react";
import { Check, Loader2, PenLine, Trash2 } from "lucide-react";
import { date, money, type Order } from "../data";
import type { OrderChange, OrderDetail } from "../api";
import {
  DEFAULT_CURRENCY,
  MAX_LENGTHS,
  orderCellErrors,
  parseValue,
} from "../order-csv";
import type { Workspace } from "./store";
import { go, type Notify } from "./ui";

const FIELDS = [
  { key: "product", label: "PRODUCT" },
  { key: "supplier", label: "SUPPLIER" },
  { key: "destination", label: "DESTINATION" },
  { key: "value", label: "ORDER VALUE" },
  { key: "currency", label: "CURRENCY" },
  { key: "shipDate", label: "SHIP DATE" },
  { key: "hsCode", label: "HS CODE" },
] as const;
type Draft = Record<(typeof FIELDS)[number]["key"], string>;
const TEXT_FIELDS = [
  "product",
  "supplier",
  "destination",
  "shipDate",
  "hsCode",
] as const;

const currencyOf = (order: Order) => order.currency ?? DEFAULT_CURRENCY;
const draftOf = (order: Order): Draft => ({
  product: order.product,
  supplier: order.supplier,
  destination: order.destination,
  value: String(order.value),
  currency: currencyOf(order),
  shipDate: order.shipDate,
  hsCode: order.hsCode,
});

// Only what differs from the order, as the backend stores it.
function changeOf(order: Order, draft: Draft): OrderChange {
  const change: OrderChange = {};
  for (const key of TEXT_FIELDS)
    if (draft[key].trim() !== order[key]) change[key] = draft[key].trim();
  const currency = draft.currency.trim().toUpperCase();
  if (currency !== currencyOf(order)) change.currency = currency;
  const value = parseValue(draft.value.trim());
  if (value !== order.value) change.value = value;
  return change;
}

export function OrderFacts({
  order,
  ws,
  notify,
  onSaved,
}: {
  order: Order;
  ws: Workspace;
  notify: Notify;
  // Signed in: the order's page after the change and its new analysis.
  onSaved?: (detail: OrderDetail) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "remove">("view");
  const [draft, setDraft] = useState(() => draftOf(order));
  const edit = () => {
    setDraft(draftOf(order));
    setMode("edit");
  };
  if (mode === "edit")
    return (
      <OrderForm
        order={order}
        draft={draft}
        onDraft={setDraft}
        ws={ws}
        onCancel={() => setMode("view")}
        onSubmit={(change) =>
          ws.mutate(async () => {
            const updated = await ws.saveOrder(order, change);
            setMode("view");
            if (!updated) {
              notify(`${order.id} saved and checked again.`);
              return;
            }
            await onSaved?.(updated.detail);
            const status = ws.statusOption(updated.detail.order.status);
            notify(
              updated.run
                ? `${order.id} saved and analysed again${status ? `: ${status.label}` : ""}.`
                : `${order.id} saved. Its analysis didn't run: use “Analyse again” below.`,
              !updated.run,
            );
          })
        }
      />
    );
  return (
    <>
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
          <b>{order.hsCode || "—"}</b>
        </div>
      </div>
      {ws.editable &&
        (mode === "remove" ? (
          <div
            className="order-remove-confirm"
            role="group"
            aria-label={`Remove ${order.id}`}
          >
            <p>
              Remove {order.id}?{" "}
              {ws.live
                ? "Its status history, analysis reports, supplier messages, HS code suggestions and saved what-ifs go with it. The activity log keeps a record of what the order was, and importing it again brings it back as a new order."
                : "It goes from this browser's sample workspace."}
            </p>
            <div className="order-facts-actions">
              <button
                type="button"
                className="btn order-remove"
                disabled={ws.busy}
                onClick={() =>
                  ws.mutate(async () => {
                    await ws.removeOrder(order.id);
                    notify(`${order.id} removed.`);
                    go("orders");
                  })
                }
              >
                {ws.busy ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Trash2 size={15} />
                )}
                Remove {order.id}
              </button>
              <button
                type="button"
                className="text-link"
                onClick={() => setMode("view")}
              >
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <div className="order-facts-actions">
            <button type="button" className="text-link" onClick={edit}>
              <PenLine size={14} />
              Edit order
            </button>
            <button
              type="button"
              className="text-link order-remove-link"
              onClick={() => setMode("remove")}
            >
              <Trash2 size={14} />
              Remove order
            </button>
          </div>
        ))}
    </>
  );
}

function OrderForm({
  order,
  draft,
  onDraft,
  ws,
  onCancel,
  onSubmit,
}: {
  order: Order;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  ws: Workspace;
  onCancel: () => void;
  onSubmit: (change: OrderChange) => void;
}) {
  // The first problem of each field, by the CSV's rules.
  const errors = new Map<string, string>();
  for (const { column, message } of orderCellErrors((column) =>
    column === "id" ? order.id : (draft[column as keyof Draft] ?? "").trim(),
  ))
    if (!errors.has(column)) errors.set(column, message);
  const change = changeOf(order, draft);
  const changed = Object.keys(change).length > 0;
  function save(event: FormEvent) {
    event.preventDefault();
    if (changed && !errors.size && !ws.busy) onSubmit(change);
  }
  return (
    <form
      className="order-edit"
      aria-label={`Edit ${order.id}`}
      onSubmit={save}
    >
      <div className="order-edit-fields">
        {FIELDS.map(({ key, label }) => (
          <label key={key}>
            <small>{label}</small>
            <input
              name={key}
              type={key === "shipDate" ? "date" : "text"}
              inputMode={key === "value" ? "decimal" : undefined}
              maxLength={
                key === "currency" ? 3 : (MAX_LENGTHS[key] ?? undefined)
              }
              placeholder={key === "hsCode" ? "e.g. 4412.33" : undefined}
              value={draft[key]}
              aria-invalid={errors.has(key)}
              onChange={(e) => onDraft({ ...draft, [key]: e.target.value })}
            />
            {errors.has(key) && <em role="alert">{errors.get(key)}</em>}
          </label>
        ))}
      </div>
      <p className="fine-print">
        The order ID stays {order.id}.{" "}
        {ws.live
          ? "Saving records each change in the activity log and analyses the order again. The CSV row it came from stays as it was imported."
          : "Saving checks the order against the sample rule change again."}
      </p>
      <div className="order-facts-actions">
        <button
          className="btn"
          type="submit"
          disabled={ws.busy || !changed || errors.size > 0}
        >
          {ws.busy ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <Check size={15} />
          )}
          Save changes
        </button>
        <button type="button" className="text-link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
