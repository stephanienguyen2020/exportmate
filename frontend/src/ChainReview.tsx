// Chain admins' review of material chain versions (backend services/chain_versions.py): each
// draft (from the pipeline or a changed file in data/industries/) with what it changes against
// the published version and what the pipeline flagged, to publish or reject with a note.
// Publishing rebuilds the graph News watch, the graph query API and the assistant walk.
import { useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { api, type ChainDiffLink, type ChainVersion, type ChainVersionSummary } from "./api";
import { errorMessage } from "./auth";

function DiffLinks({ title, links, tone }: { title: string; links: ChainDiffLink[]; tone: string }) {
  if (!links.length) return null;
  return (
    <div className={`mc-diff ${tone}`}>
      <h4>
        {title} ({links.length})
      </h4>
      <ul>
        {links.map((link) => (
          <li key={`${link.fromKey}>${link.toKey}>${link.relation}`}>
            <b>{link.fromName}</b> {link.relation === "by_product" ? "leaves" : "used to make"} <b>{link.toName}</b>
            {link.changed.length > 0 && <small> · changed: {link.changed.join(", ")}</small>}
            <p className="mc-quote">
              {link.quote ? `“${link.quote}”` : link.basis}{" "}
              {link.sourceUrl ? (
                <a href={link.sourceUrl} target="_blank" rel="noopener noreferrer">
                  {link.sourceTitle}
                  <ExternalLink size={10} aria-hidden="true" />
                </a>
              ) : (
                <span>{link.sourceTitle}</span>
              )}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The pipeline's notes for a person: lists of links it dropped, links no longer sourced, …
function Flagged({ flagged }: { flagged: Record<string, unknown> | null }) {
  const entries = Object.entries(flagged ?? {}).filter(([, v]) => (Array.isArray(v) ? v.length : v));
  if (!entries.length) return <p className="mc-muted">The pipeline flagged nothing.</p>;
  return (
    <div className="mc-diff amber">
      <h4>Flagged by the pipeline</h4>
      <ul>
        {entries.map(([key, value]) => (
          <li key={key}>
            <b>{key}</b>: {Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("; ") : String(value)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Draft({ summary, onReviewed }: { summary: ChainVersionSummary; onReviewed: () => void }) {
  const [version, setVersion] = useState<ChainVersion | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api
      .chainVersion(summary.id, controller.signal)
      .then((v) => !controller.signal.aborted && setVersion(v))
      .catch((e) => !controller.signal.aborted && setError(errorMessage(e)));
    return () => controller.abort();
  }, [summary.id]);
  const review = async (action: "publish" | "reject") => {
    if (action === "reject" && !note.trim()) {
      setError("Say why you reject it, for whoever builds the next draft.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await (action === "publish" ? api.publishChainVersion(summary.id, note.trim()) : api.rejectChainVersion(summary.id, note.trim()));
      onReviewed();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const changes = version?.changes;
  return (
    <li className="mc-draft" aria-label={`${summary.industryName} version ${summary.number}`}>
      <div className="mc-link-head">
        <b>
          {summary.industryName}, version {summary.number}
        </b>
        <span className="status amber">
          <i />
          Draft
        </span>
        <small className="mc-muted">
          {summary.linkCount} links · {summary.note ?? summary.origin} · {new Date(summary.createdAt).toLocaleDateString()}
        </small>
      </div>
      {!version && !error && <Loader2 className="spin" size={16} aria-label="Loading the draft" />}
      {changes && (
        <>
          {(changes.productsAdded.length > 0 || changes.productsRemoved.length > 0) && (
            <p>
              {changes.productsAdded.length > 0 && <>Products added: {changes.productsAdded.join(", ")}. </>}
              {changes.productsRemoved.length > 0 && <>Products removed: {changes.productsRemoved.join(", ")}.</>}
            </p>
          )}
          <DiffLinks title="Links added" links={changes.linksAdded} tone="green" />
          <DiffLinks title="Links changed" links={changes.linksChanged} tone="blue" />
          <DiffLinks title="Links removed" links={changes.linksRemoved} tone="red" />
          {!changes.linksAdded.length && !changes.linksChanged.length && !changes.linksRemoved.length && (
            <p className="mc-muted">No link changes against the published version.</p>
          )}
          <Flagged flagged={version.flagged} />
        </>
      )}
      <label className="mc-note">
        Note (required to reject)
        <textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} rows={2} />
      </label>
      {error && (
        <p className="news-error" role="alert">
          {error}
        </p>
      )}
      <div className="mc-actions">
        <button className="btn" disabled={busy || !version} onClick={() => review("publish")}>
          Publish version {summary.number}
        </button>
        <button className="btn ghost" disabled={busy || !version} onClick={() => review("reject")}>
          Reject
        </button>
      </div>
    </li>
  );
}

export default function ChainReview({ onReviewed }: { onReviewed: () => void }) {
  const [versions, setVersions] = useState<ChainVersionSummary[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api
      .chainVersions(controller.signal)
      .then((v) => !controller.signal.aborted && setVersions(v))
      .catch((e) => !controller.signal.aborted && setError(errorMessage(e)));
    return () => controller.abort();
  }, [reload]);
  const drafts = versions?.filter((v) => v.status === "draft") ?? [];
  return (
    <section className="panel mc-review" aria-label="Chain versions to review">
      <h2>Chain versions to review</h2>
      <p className="mc-muted">
        You're a chain admin. Publishing a draft rebuilds the graph News watch, the assistant and every company walk.
      </p>
      {error && (
        <p className="news-error" role="alert">
          {error}
        </p>
      )}
      {versions && !drafts.length && <p className="mc-muted">No drafts waiting.</p>}
      {drafts.length > 0 && (
        <ul className="mc-drafts">
          {drafts.map((d) => (
            <Draft
              key={d.id}
              summary={d}
              onReviewed={() => {
                setReload((n) => n + 1);
                onReviewed();
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
