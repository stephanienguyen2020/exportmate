import React, { useState } from "react";
import { Check, ChevronDown, ExternalLink, Link2, Loader2, Undo2, X } from "lucide-react";
import type { NewsMatch, NewsPathStep, NewsVerdict } from "../../src/api";
import { date, type Order } from "../../src/data";

type Actions = {
  onReview: (orderId: string, verdict: NewsVerdict, note: string | null) => Promise<void>;
  onClear: (orderId: string) => Promise<void>;
};

const orderLink = (id: string) => "#/workspace/orders/" + encodeURIComponent(id);
const reviewedOn = (s: string) => new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Counts for an alert's order matches: awaiting a verdict, confirmed, and all. */
export function matchCounts(matches: NewsMatch[] = []) {
  return {
    toReview: matches.filter((m) => !m.review).length,
    confirmed: matches.filter((m) => m.review?.verdict === "relevant").length,
    total: matches.length,
  };
}

const isWebLink = (url: string | null): url is string => Boolean(url && /^https?:\/\//.test(url));

/** How the knowledge graph reached the order: what the alert names, the supplier that buys it,
 * and each step of the material chain to the order's product, with the source behind each link. */
function MatchPath({ path }: { path: NewsPathStep[] }) {
  const steps = path.filter((s) => s.kind !== "order");
  return (
    <ol className="news-path" aria-label="How this order is linked to the alert">
      {steps.map((step, i) => (
        <li key={i} className={`news-path-${step.kind}`}>
          <span className="news-path-link">{step.kind === "mention" ? "named in the alert" : step.link}</span>{" "}
          <span className="news-path-label">{step.label}</span>
          {isWebLink(step.sourceUrl) && (
            <a
              className="news-path-source"
              href={step.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={step.quote ? `${step.sourceTitle}: “${step.quote}”` : step.sourceTitle || undefined}
            >
              <ExternalLink size={10} aria-hidden="true" />
              <span className="sr-only">Source: {step.sourceTitle}</span>
            </a>
          )}
        </li>
      ))}
    </ol>
  );
}

function MatchRow({ match, canReview, onReview, onClear }: { match: NewsMatch; canReview: boolean } & Actions) {
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      setNote("");
      setNoting(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the verdict.");
    } finally {
      setBusy(false);
    }
  };
  const review = match.review;
  const confirmed = review?.verdict === "relevant";
  return (
    <li className={review ? (confirmed ? "confirmed" : "rejected") : ""}>
      <div className="news-order-row">
        <div className="news-order-main">
          <div className="news-order-head">
            <a className="order-link" href={orderLink(match.orderId)}>
              {match.orderId}
            </a>
            <span>
              {match.product} · {match.destination} · ships {date(match.shipDate)}
            </span>
          </div>
          <small title={match.reason}>{match.reason}</small>
          {match.path?.some((s) => s.kind === "supplier") && <MatchPath path={match.path} />}
          {review && (
            <small>
              {review.reviewedBy.name} · {reviewedOn(review.reviewedAt)}
              {review.note && <> · “{review.note}”</>}
            </small>
          )}
        </div>
        {review ? (
          <div className="news-order-verdict">
            <span className={`status ${confirmed ? "green" : "grey"}`}>
              <i />
              {confirmed ? "Affects this order" : "Not relevant"}
            </span>
            {canReview && (
              <button
                type="button"
                className="news-more"
                disabled={busy}
                onClick={() => act(() => onClear(match.orderId))}
                aria-label={`Undo the verdict on ${match.orderId}`}
              >
                <Undo2 size={12} /> Undo
              </button>
            )}
          </div>
        ) : canReview ? (
          <div className="news-order-actions">
            <button
              type="button"
              className="news-more"
              aria-expanded={noting}
              onClick={() => setNoting(!noting)}
              aria-label={`Add a note on ${match.orderId}`}
            >
              {noting ? "No note" : "Add note"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => act(() => onReview(match.orderId, "relevant", note.trim() || null))}
              aria-label={`${match.orderId}: affects this order`}
              title="Affects this order"
            >
              {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Affects
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => act(() => onReview(match.orderId, "not_relevant", note.trim() || null))}
              aria-label={`${match.orderId}: not relevant`}
              title="Not relevant"
            >
              <X size={13} /> Not relevant
            </button>
          </div>
        ) : (
          <div className="news-order-verdict">
            <span className="status amber">
              <i />
              Awaiting review
            </span>
          </div>
        )}
      </div>
      {noting && !review && (
        <input
          className="news-order-note"
          aria-label={`Note on ${match.orderId} (optional)`}
          placeholder="Note (optional), saved with your verdict"
          maxLength={500}
          value={note}
          autoFocus
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      {error && <div className="news-error">{error}</div>}
    </li>
  );
}

/** On an alert card: the orders it may affect, for a person to confirm or reject. */
export function OrderMatches({
  matches,
  orders,
  canReview,
  ...actions
}: { matches: NewsMatch[]; orders: Order[]; canReview: boolean } & Actions) {
  const [open, setOpen] = useState(false);
  const [linking, setLinking] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const listed = new Set(matches.map((m) => m.orderId));
  const linkable = orders.filter((o) => !listed.has(o.id));
  const { toReview, confirmed } = matchCounts(matches);
  const link = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!linking) return;
    setBusy(true);
    setError("");
    try {
      await actions.onReview(linking, "relevant", null);
      setLinking("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't link the order.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`news-orders${open ? " open" : ""}`}>
      <h4>
        <button type="button" className="news-orders-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronDown size={14} aria-hidden="true" />
          Orders this may affect
          {matches.length > 0 && <span className="news-orders-count">{matches.length}</span>}
          {toReview > 0 && <span className="status amber">{toReview} to review</span>}
          {confirmed > 0 && <span className="status green">{confirmed} confirmed</span>}
        </button>
      </h4>
      {open &&
        (matches.length ? (
          <ul>
            {matches.map((m) => (
              <MatchRow key={m.orderId} match={m} canReview={canReview} {...actions} />
            ))}
          </ul>
        ) : (
          <p className="news-note">No open order is linked to what this alert names.</p>
        ))}
      {open && canReview && linkable.length > 0 && (
        <form className="news-order-link" onSubmit={link}>
          <select aria-label="Order to link" value={linking} onChange={(e) => setLinking(e.target.value)}>
            <option value="">Link another order…</option>
            {linkable.map((o) => (
              <option key={o.id} value={o.id}>
                {o.id} · {o.product}
              </option>
            ))}
          </select>
          <button type="submit" className="btn secondary" disabled={!linking || busy}>
            {busy ? <Loader2 size={13} className="spin" /> : <Link2 size={13} />} Link order
          </button>
        </form>
      )}
      {error && <div className="news-error">{error}</div>}
    </section>
  );
}
