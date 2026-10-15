// An order's status on its page for a signed-in company: what it is, who or which analysis
// set it and why, and (owners and editors) a change by hand with a note. The statuses, their
// labels and which may be set by hand come from the database (GET /order-statuses); every
// change is saved on the order's history and in the audit log by the backend. BulkStatusBar
// does the same for the orders ticked on the Orders page, with one note for all of them.
import { useState, type FormEvent } from "react";
import { Loader2, PenLine, X } from "lucide-react";
import {
  api,
  type OrderDetail,
  type OrderStatusChange,
  type OrderStatusOption,
} from "./api";
import { errorMessage } from "./auth";
import "./analysis.css";

type Role = "owner" | "editor" | "viewer" | null;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function OrderStatusPanel({
  detail,
  options,
  role,
  notify,
  onChanged,
}: {
  detail: OrderDetail;
  options: OrderStatusOption[];
  role: Role;
  notify: (text: string, error?: boolean) => void;
  onChanged: (detail: OrderDetail) => void | Promise<void>;
}) {
  const order = detail.order;
  const changes = detail.statusChanges ?? [];
  const editable = role === "owner" || role === "editor";
  const choices = options.filter((o) => o.manual && o.code !== order.status);
  const [next, setNext] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const label = (code: string) =>
    options.find((o) => o.code === code)?.label ?? code;
  const current = options.find((o) => o.code === order.status);

  async function save(event: FormEvent) {
    event.preventDefault();
    const option = choices.find((o) => o.code === next);
    if (!option || !note.trim() || busy) return;
    setBusy(true);
    try {
      const updated = await api.changeOrderStatus(
        order.id,
        option.code,
        note.trim(),
      );
      setNext("");
      setNote("");
      notify(`${order.id} is now “${option.label}”.`);
      await onChanged(updated);
    } catch (error) {
      notify(errorMessage(error), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel an-status" aria-labelledby="an-status-title">
      <div className="an-report-head">
        <div>
          <h2 id="an-status-title">Status</h2>
          <p>
            {current ? (
              <>
                <span className={`status ${current.tone}`}>
                  <i />
                  {current.label}
                </span>{" "}
                {current.description}
              </>
            ) : (
              label(order.status)
            )}
          </p>
        </div>
      </div>
      {editable && choices.length > 0 && (
        <form className="an-status-form" onSubmit={save}>
          <label htmlFor="an-status-next">Change the status to</label>
          <select
            id="an-status-next"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          >
            <option value="">Choose a status…</option>
            {choices.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
          </select>
          <label htmlFor="an-status-note">Note: why (required)</label>
          <textarea
            id="an-status-note"
            rows={2}
            maxLength={1000}
            required
            value={note}
            placeholder="e.g. Supplier sent the missing certificate by email on 14 Oct."
            onChange={(e) => setNote(e.target.value)}
          />
          <small>
            The change and your note are saved on this order and in the
            activity log. The next analysis of this order sets its status
            again.
          </small>
          <button
            className="btn"
            disabled={busy || !next || !note.trim()}
            type="submit"
          >
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <PenLine size={15} />
            )}
            Change status
          </button>
        </form>
      )}
      <h3>History</h3>
      {changes.length ? (
        <ol className="an-status-history">
          {changes.map((c) => (
            <HistoryItem key={c.id} change={c} label={label} />
          ))}
        </ol>
      ) : (
        <p>No status changes recorded yet.</p>
      )}
    </section>
  );
}

function HistoryItem({
  change,
  label,
}: {
  change: OrderStatusChange;
  label: (code: string) => string;
}) {
  return (
    <li>
      <span>
        {label(change.fromStatus)} → <b>{label(change.toStatus)}</b>
      </span>
      <small>
        {change.source === "manual"
          ? `Changed by ${change.changedBy.name}`
          : `Analysis run started by ${change.changedBy.name}`}{" "}
        · {when(change.changedAt)}
      </small>
      {change.note && <q>{change.note}</q>}
    </li>
  );
}

// The orders ticked on the Orders page (owners and editors): one status and one note for all
// of them. The backend changes all of them or none, and leaves alone those that already have
// the status.
export function BulkStatusBar({
  ids,
  options,
  notify,
  onChanged,
  onClear,
}: {
  ids: string[];
  options: OrderStatusOption[];
  notify: (text: string, error?: boolean) => void;
  onChanged: () => void | Promise<void>;
  onClear: () => void;
}) {
  const choices = options.filter((o) => o.manual);
  const [next, setNext] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const count = ids.length === 1 ? "1 order" : `${ids.length} orders`;

  async function save(event: FormEvent) {
    event.preventDefault();
    const option = choices.find((o) => o.code === next);
    if (!option || !note.trim() || !ids.length || busy) return;
    setBusy(true);
    try {
      const result = await api.changeOrderStatuses(
        ids,
        option.code,
        note.trim(),
      );
      const changed = result.changed.length;
      const already = result.unchanged.length;
      notify(
        `${changed === 1 ? "1 order is" : `${changed} orders are`} now “${option.label}”.` +
          (already
            ? ` ${already === 1 ? "1 already was" : `${already} already were`}.`
            : ""),
      );
      setNext("");
      setNote("");
      await onChanged();
    } catch (error) {
      notify(errorMessage(error), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="panel an-bulk-status"
      aria-label="Change the status of the selected orders"
      onSubmit={save}
    >
      <b role="status">{count} selected</b>
      <label>
        <span>Change the status to</span>
        <select value={next} onChange={(e) => setNext(e.target.value)} required>
          <option value="">Choose a status…</option>
          {choices.map((o) => (
            <option key={o.code} value={o.code}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="an-bulk-note">
        <span>Note: why (required)</span>
        <input
          maxLength={1000}
          required
          value={note}
          placeholder="e.g. Supplier sent the missing certificate by email on 14 Oct."
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button
        className="btn"
        disabled={busy || !next || !note.trim()}
        type="submit"
      >
        {busy ? <Loader2 size={15} className="spin" /> : <PenLine size={15} />}
        Change {count}
      </button>
      <button
        className="text-link"
        type="button"
        disabled={busy}
        onClick={onClear}
      >
        <X size={14} />
        Clear selection
      </button>
      <small>
        Each order's change and your note are saved on its history and in the
        activity log. The next analysis of an order sets its status again.
      </small>
    </form>
  );
}
