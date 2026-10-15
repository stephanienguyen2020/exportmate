import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CircleAlert,
  Download,
  FileText,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import {
  api,
  type DraftedRequirements,
  type MarketRequirement,
  type MarketRequirementUpdate,
  type Regulation,
  type RegulationDetail,
  type RegulationDocument,
  type RequirementSource,
  type VersionRequirements,
} from "./api";
import { errorMessage } from "./auth";
import ErrorBoundary from "./ErrorBoundary";
import "./regulations.css";

const library = "#/workspace/regulations";
const regulationLink = (id: string) => `${library}/${encodeURIComponent(id)}`;
const documentLink = (id: string) =>
  `${library}/documents/${encodeURIComponent(id)}`;
const timestamp = (value: string) =>
  new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
export function sourceLink(value: string | null): string | undefined {
  try {
    const url = new URL(value || "");
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
export function RegulationCitation({ source }: { source?: RequirementSource }) {
  if (!source) return null;
  return (
    <details className="reg-citation">
      <summary>
        Source · {source.officialId || source.regulationTitle} · v
        {source.versionNumber}
      </summary>
      <blockquote>{source.quote}</blockquote>
      <a className="text-link" href={documentLink(source.documentId)}>
        View source document <ArrowUpRight size={13} />
      </a>
    </details>
  );
}
function DownloadButton({ document }: { document: RegulationDocument }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  return (
    <div>
      <button
        className="btn secondary"
        disabled={busy}
        onClick={async () => {
          if (pending.current) return;
          pending.current = true;
          setBusy(true);
          setError("");
          try {
            await api.downloadRegulation(document.id, document.filename);
          } catch (error) {
            setError(errorMessage(error));
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      >
        <Download size={15} />
        {busy ? "Downloading…" : "Download file"}
      </button>
      {error && (
        <p className="reg-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
function DocumentCard({
  document,
  metadata = false,
}: {
  document: RegulationDocument;
  metadata?: boolean;
}) {
  const href = sourceLink(document.sourceUrl);
  return (
    <article className="reg-version">
      <div className="reg-version-title">
        <span className="reg-badge">VERSION {document.versionNumber}</span>
        <span>{timestamp(document.createdAt)}</span>
      </div>
      <h3>
        <a href={documentLink(document.id)}>{document.title}</a>
      </h3>
      <p className="reg-muted">
        {document.filename} · {size(document.sizeBytes)} ·{" "}
        {document.contentType}
      </p>
      <div className="reg-actions">
        <DownloadButton document={document} />
        {href && (
          <a className="text-link" href={href} target="_blank" rel="noreferrer">
            Original source <ArrowUpRight size={14} />
          </a>
        )}
      </div>
      {metadata && (
        <dl className="reg-metadata">
          <dt>SHA-256 checksum</dt>
          <dd>
            <code>{document.checksum}</code>
          </dd>
          <dt>Document ID</dt>
          <dd>{document.id}</dd>
        </dl>
      )}
    </article>
  );
}
function UploadForm({
  regulation,
  onUploaded,
}: {
  regulation?: Regulation;
  onUploaded: (document: RegulationDocument) => void;
}) {
  const [title, setTitle] = useState(regulation?.title || "");
  const [officialId, setOfficialId] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    setError("");
    if (!file) {
      setError("Choose a document to upload.");
      return;
    }
    if (!title.trim()) {
      setError("Enter a document title.");
      return;
    }
    if (!/\.(pdf|html?|txt)$/i.test(file.name)) {
      setError("Choose a PDF, HTML or TXT file.");
      return;
    }
    if (!file.size || file.size > 4 * 1024 * 1024) {
      setError("Choose a non-empty file up to 4 MB.");
      return;
    }
    if (sourceUrl.trim() && !sourceLink(sourceUrl.trim())) {
      setError("The source URL must start with https:// or http://.");
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      if (
        /\.pdf$/i.test(file.name) &&
        (await file.slice(0, 5).text()) !== "%PDF-"
      )
        throw new Error(
          "This file is not a valid PDF. Choose the original PDF file.",
        );
      const form = new FormData();
      form.append("file", file);
      form.append("title", title.trim());
      if (sourceUrl.trim()) form.append("sourceUrl", sourceUrl.trim());
      if (regulation) form.append("regulationId", regulation.id);
      else if (officialId.trim()) form.append("officialId", officialId.trim());
      onUploaded(await api.uploadRegulation(form));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <form className="panel reg-form" onSubmit={submit}>
      <h2>
        {regulation
          ? `Add version ${regulation.versionCount + 1}`
          : "Add a regulation"}
      </h2>
      <p>
        {regulation
          ? `New document for ${regulation.title}. Previous versions stay available.`
          : "Keep a reference text and its versions in your company library."}
      </p>
      <fieldset disabled={busy}>
        <label>
          Document title
          <input
            required
            maxLength={300}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {!regulation && (
          <label>
            Official ID <span>(optional)</span>
            <input
              maxLength={100}
              value={officialId}
              onChange={(event) => setOfficialId(event.target.value)}
              placeholder="e.g. 32023R1115"
            />
          </label>
        )}
        <label>
          Source URL <span>(optional)</span>
          <input
            type="url"
            maxLength={2000}
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            placeholder="https://…"
          />
        </label>
        <label className="reg-file">
          <Upload size={22} />
          Document file
          <input
            type="file"
            accept=".pdf,.html,.htm,.txt"
            required
            onChange={(event) => setFile(event.target.files?.[0] || null)}
          />
          <span>PDF, HTML or TXT · up to 4 MB</span>
        </label>
      </fieldset>
      <p className="reg-muted">
        Files are stored as references. After uploading, you can ask AI to
        draft the market requirements this version sets, for the owner to
        review.
      </p>
      {error && (
        <p className="reg-error" role="alert">
          {error}{" "}
          {error.includes("official") && (
            <a href={library}>Find the existing regulation to add a version.</a>
          )}
        </p>
      )}
      <div className="reg-actions">
        <button className="btn" type="submit" disabled={busy}>
          <Upload size={16} />
          {busy ? "Uploading…" : "Upload document"}
        </button>
        <a
          className="text-link"
          href={regulation ? regulationLink(regulation.id) : library}
        >
          Back to {regulation ? "regulation" : "library"}
        </a>
      </div>
    </form>
  );
}
const LEVELS: { value: MarketRequirement["level"]; label: string }[] = [
  { value: "supplier", label: "Supplier evidence" },
  { value: "shipment", label: "Per shipment" },
  { value: "check", label: "Check" },
];
const DROP_REASONS: Record<string, string> = {
  quote_not_in_document: "the quote wasn't in the document",
  unknown_market: "an unknown market",
  unknown_document_kind: "an unknown document kind",
};
const list = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** The market requirements one version of a regulation sets: AI drafts them from a company's
 *  own regulation; the owner edits, approves or rejects each one. */
function RequirementReview({
  regulation,
  editable,
  owner,
}: {
  regulation: RegulationDetail;
  editable: boolean;
  owner: boolean;
}) {
  const latest = regulation.versions[0]?.versionNumber;
  const [version, setVersion] = useState(latest);
  const [data, setData] = useState<VersionRequirements | null>(null);
  const [drafted, setDrafted] = useState<DraftedRequirements | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!version) return;
    const controller = new AbortController();
    setData(null);
    setError("");
    api
      .versionRequirements(regulation.id, version, controller.signal)
      .then((value) => !controller.signal.aborted && setData(value))
      .catch((e) => !controller.signal.aborted && setError(errorMessage(e)));
    return () => controller.abort();
  }, [regulation.id, version, retry]);
  if (!version) return null;
  const document = regulation.versions.find((v) => v.versionNumber === version);
  const decided = data?.requirements.some((r) => r.status !== "draft");
  const draft = async () => {
    if (!document || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.draftRequirements(document.id);
      setDrafted(result);
      setData(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const replace = (next: MarketRequirement) =>
    setData((current) =>
      current && {
        ...current,
        requirements: current.requirements.map((r) =>
          r.id === next.id ? next : r,
        ),
      },
    );
  const dropped = Object.entries(drafted?.dropped || {}).filter(([, n]) => n > 0);
  return (
    <section className="panel reg-requirements" aria-label="Market requirements">
      <div className="reg-requirements-head">
        <div>
          <h2>Market requirements</h2>
          <p className="reg-muted">
            What this text requires of an order, each line with its quote.
            Orders are checked against a version once every line is reviewed
            or rejected.
          </p>
        </div>
        {regulation.versions.length > 1 && (
          <label>
            Version
            <select
              value={version}
              onChange={(e) => {
                setDrafted(null);
                setVersion(Number(e.target.value));
              }}
            >
              {regulation.versions.map((v) => (
                <option key={v.id} value={v.versionNumber}>
                  Version {v.versionNumber}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && (
        <p className="reg-error" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        !error && (
          <p role="status">
            <Loader2 size={15} className="spin" /> Loading…
          </p>
        )
      ) : (
        <>
          <p className="reg-muted">
            <span className={"reg-badge" + (data.inForce ? "" : " off")}>
              {data.inForce ? "IN FORCE" : "NOT IN FORCE"}
            </span>{" "}
            Version {data.versionNumber}
            {data.previousVersionNumber
              ? ` · compared with version ${data.previousVersionNumber}`
              : ""}
          </p>
          {editable && !regulation.shared && !decided && (
            <div className="reg-actions">
              <button className="btn" disabled={busy} onClick={draft}>
                {busy ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Sparkles size={15} />
                )}
                {busy
                  ? "Reading the text…"
                  : data.requirements.length
                    ? "Draft requirements again"
                    : "Draft requirements"}
              </button>
              <span className="reg-muted">
                AI reads this version and drafts each requirement with its
                quote. {owner ? "You" : "The owner"} then review
                {owner ? "" : "s"} them.
              </span>
            </div>
          )}
          {drafted && (
            <p className="reg-muted" role="status">
              {drafted.readAs === "scanned_file"
                ? "Read from a scanned file: the quotes couldn't be checked against its text. "
                : ""}
              {drafted.sectionsSelected
                ? "A long text: only its closest sections were read. "
                : ""}
              {dropped.length
                ? `Dropped ${dropped
                    .map(([reason, n]) => `${n} for ${DROP_REASONS[reason] || reason.replace(/_/g, " ")}`)
                    .join(", ")}.`
                : ""}
            </p>
          )}
          {data.changes.length > 0 && (
            <>
              <h3>Changes from version {data.previousVersionNumber}</h3>
              <ul className="reg-changes">
                {data.changes.map((c) => (
                  <li key={`${c.marketCode}-${c.requirementKey}`}>
                    <span className={"reg-badge " + c.change}>
                      {c.change.toUpperCase()}
                    </span>{" "}
                    {c.marketCode} · {c.title}
                    {c.fields.length > 0 && (
                      <small> ({c.fields.join(", ")})</small>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {data.requirements.length ? (
            <ul className="reg-req-list">
              {data.requirements.map((requirement) => (
                <RequirementItem
                  key={requirement.id}
                  requirement={requirement}
                  owner={owner && !requirement.shared}
                  onChange={(next) => {
                    replace(next);
                    // In force may change once every line is decided.
                    if (next.status !== "draft") setRetry((n) => n + 1);
                  }}
                />
              ))}
            </ul>
          ) : (
            <p className="reg-muted">
              {regulation.shared
                ? "No requirements are recorded for this version."
                : "No requirements drafted for this version yet."}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function RequirementItem({
  requirement: r,
  owner,
  onChange,
}: {
  requirement: MarketRequirement;
  owner: boolean;
  onChange: (next: MarketRequirement) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => ({
    marketCode: r.marketCode,
    title: r.title,
    level: r.level,
    documentKind: r.documentKind ?? "",
    hsPrefixes: r.hsPrefixes.join(", "),
    acceptedStandards: r.acceptedStandards.join(", "),
    why: r.why,
    sourceQuote: r.sourceQuote,
    effectiveOn: r.effectiveOn ?? "",
    dutyRatePercent: r.dutyRatePercent == null ? "" : String(r.dutyRatePercent),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = async (change: MarketRequirementUpdate) => {
    setBusy(true);
    setError("");
    try {
      onChange(await api.reviewRequirement(r.id, change));
      setEditing(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const edits = (): MarketRequirementUpdate => ({
    marketCode: form.marketCode.trim().toUpperCase(),
    title: form.title.trim(),
    level: form.level,
    documentKind: form.documentKind.trim() || null,
    hsPrefixes: list(form.hsPrefixes),
    acceptedStandards: list(form.acceptedStandards),
    why: form.why.trim(),
    // Only sent when changed: the server then counts the quote as checked by a person.
    ...(form.sourceQuote !== r.sourceQuote
      ? { sourceQuote: form.sourceQuote.trim() }
      : {}),
    effectiveOn: form.effectiveOn || null,
    dutyRatePercent: form.dutyRatePercent.trim()
      ? Number(form.dutyRatePercent)
      : null,
  });
  const set = (change: Partial<typeof form>) =>
    setForm((all) => ({ ...all, ...change }));
  return (
    <li className="reg-req">
      <div className="reg-version-title">
        <span className="reg-badge">{r.marketCode}</span>
        <span
          className={
            "reg-badge " + (r.status === "draft" ? "draft" : r.status)
          }
        >
          {r.status.toUpperCase()}
        </span>
        <span>{LEVELS.find((l) => l.value === r.level)?.label}</span>
      </div>
      <h3>{r.title}</h3>
      <p>{r.why}</p>
      <dl className="reg-metadata">
        {r.documentKind && (
          <>
            <dt>Document</dt>
            <dd>{r.documentKind}</dd>
          </>
        )}
        {r.hsPrefixes.length > 0 && (
          <>
            <dt>HS codes starting</dt>
            <dd>{r.hsPrefixes.join(", ")}</dd>
          </>
        )}
        {r.acceptedStandards.length > 0 && (
          <>
            <dt>Accepted standards</dt>
            <dd>{r.acceptedStandards.join(", ")}</dd>
          </>
        )}
        {r.effectiveOn && (
          <>
            <dt>From</dt>
            <dd>{r.effectiveOn}</dd>
          </>
        )}
        {r.dutyRatePercent != null && (
          <>
            <dt>Duty</dt>
            <dd>{r.dutyRatePercent}%</dd>
          </>
        )}
      </dl>
      <blockquote>{r.sourceQuote}</blockquote>
      {!r.quoteVerified && (
        <p className="reg-warning">
          <CircleAlert size={14} /> This quote wasn't found in the document's
          text. Check it against the file before approving.
        </p>
      )}
      {owner && r.status === "draft" && !editing && (
        <div className="reg-actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => void send({ status: "reviewed" })}
          >
            <Check size={15} />
            Approve
          </button>
          <button
            className="btn secondary"
            disabled={busy}
            onClick={() => void send({ status: "rejected" })}
          >
            <X size={15} />
            Reject
          </button>
          <button className="text-link" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
      )}
      {editing && (
        <form
          className="reg-form reg-req-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send(edits());
          }}
        >
          <fieldset disabled={busy}>
            <label>
              Title
              <input
                required
                maxLength={150}
                value={form.title}
                onChange={(e) => set({ title: e.target.value })}
              />
            </label>
            <label>
              Market code
              <input
                required
                maxLength={8}
                value={form.marketCode}
                onChange={(e) => set({ marketCode: e.target.value })}
              />
            </label>
            <label>
              Level
              <select
                value={form.level}
                onChange={(e) =>
                  set({ level: e.target.value as MarketRequirement["level"] })
                }
              >
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Document kind <span>(required for supplier evidence)</span>
              <input
                maxLength={40}
                value={form.documentKind}
                onChange={(e) => set({ documentKind: e.target.value })}
              />
            </label>
            <label>
              HS code prefixes <span>(comma-separated)</span>
              <input
                value={form.hsPrefixes}
                onChange={(e) => set({ hsPrefixes: e.target.value })}
              />
            </label>
            <label>
              Accepted standards <span>(comma-separated)</span>
              <input
                value={form.acceptedStandards}
                onChange={(e) => set({ acceptedStandards: e.target.value })}
              />
            </label>
            <label>
              Why it applies
              <textarea
                required
                maxLength={2000}
                value={form.why}
                onChange={(e) => set({ why: e.target.value })}
              />
            </label>
            <label>
              Quote from the text
              <textarea
                required
                maxLength={5000}
                value={form.sourceQuote}
                onChange={(e) => set({ sourceQuote: e.target.value })}
              />
            </label>
            <label>
              Applies from <span>(optional)</span>
              <input
                type="date"
                value={form.effectiveOn}
                onChange={(e) => set({ effectiveOn: e.target.value })}
              />
            </label>
            <label>
              Duty rate % <span>(optional)</span>
              <input
                inputMode="decimal"
                value={form.dutyRatePercent}
                onChange={(e) => set({ dutyRatePercent: e.target.value })}
              />
            </label>
          </fieldset>
          <div className="reg-actions">
            <button className="btn" type="submit" disabled={busy}>
              Save draft
            </button>
            <button
              type="button"
              className="text-link"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="reg-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export default function RegulationsPage({
  live,
  editable,
  owner = false,
  path,
}: {
  live: boolean;
  editable: boolean;
  owner?: boolean;
  path: string;
}) {
  const [regulations, setRegulations] = useState<Regulation[]>([]);
  const [detail, setDetail] = useState<RegulationDetail | null>(null);
  const [document, setDocument] = useState<RegulationDocument | null>(null);
  const [loading, setLoading] = useState(live);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const parts = path.split("/").filter(Boolean);
  const isNew = parts[0] === "new";
  const isDocument = parts[0] === "documents";
  const isUpload = parts[1] === "upload";
  const isList = parts.length === 0;
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    const signal = controller.signal;
    setLoading(true);
    setError("");
    async function load() {
      try {
        if (isList) {
          const result = await api.regulations(signal);
          if (!signal.aborted) setRegulations(result);
        } else if (isDocument && parts.length === 2) {
          const result = await api.regulationDocument(parts[1], signal);
          if (!signal.aborted) setDocument(result);
        } else if (isNew && parts.length === 1) {
          /* New upload needs no existing record. */
        } else if (
          !isDocument &&
          !isNew &&
          (parts.length === 1 || (parts.length === 2 && isUpload))
        ) {
          const result = await api.regulation(parts[0], signal);
          if (!signal.aborted) setDetail(result);
        } else throw new Error("This regulation page could not be found.");
      } catch (error) {
        if (!signal.aborted) setError(errorMessage(error));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [live, path, retry]);
  const filtered = regulations.filter(
    (regulation) =>
      `${regulation.title} ${regulation.officialId || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (scope === "all" ||
        (scope === "shared" ? regulation.shared : !regulation.shared)),
  );
  return (
    <div className="reg-page">
      {!isList && (
        <a className="text-link" href={library}>
          <ArrowLeft size={15} />
          Regulation library
        </a>
      )}
      <header className="page-heading">
        <div>
          <div className="eyebrow">THE TEXT BEHIND YOUR TRADE.</div>
          <h1>
            {isNew
              ? "Upload a regulation."
              : isDocument
                ? "Source document."
                : detail
                  ? detail.title
                  : "Regulation library."}
          </h1>
          <p>
            Official texts, company references and a traceable version history.
          </p>
        </div>
        {live && editable && isList && (
          <a className="btn" href={`${library}/new`}>
            <Plus size={17} />
            Add regulation
          </a>
        )}
      </header>
      {!live ? (
        <section className="panel reg-empty">
          <FileText size={30} />
          <h2>Sign in to your company workspace</h2>
          <p>
            The regulation library contains shared official texts and your
            company’s uploaded documents.
          </p>
          <a className="btn" href="#/login">
            Sign in
          </a>
        </section>
      ) : loading ? (
        <section className="panel" role="status">
          Loading regulations…
        </section>
      ) : error ? (
        <section className="panel reg-error" role="alert">
          <h2>Couldn’t load regulations.</h2>
          <p>{error}</p>
          <button
            className="btn secondary"
            onClick={() => setRetry((value) => value + 1)}
          >
            Try again
          </button>
        </section>
      ) : (
        <>
          {isNew || isUpload ? (
            !editable ? (
              <section className="panel">
                <h2>Read-only access</h2>
                <p>Only company owners and editors can upload documents.</p>
              </section>
            ) : detail?.shared ? (
              <section className="panel">
                <h2>Shared official text</h2>
                <p>
                  Shared regulations are read-only. You can download every
                  available version.
                </p>
                <a className="text-link" href={regulationLink(detail.id)}>
                  View versions
                </a>
              </section>
            ) : (
              (isNew || detail) && (
                <UploadForm
                  regulation={detail || undefined}
                  onUploaded={(result) => {
                    window.location.hash = regulationLink(result.regulationId);
                  }}
                />
              )
            )
          ) : isDocument && document ? (
            <>
              <a
                className="text-link"
                href={regulationLink(document.regulationId)}
              >
                View regulation & all versions <ArrowUpRight size={14} />
              </a>
              <DocumentCard document={document} metadata />
            </>
          ) : detail ? (
            <>
              <section className="panel reg-summary">
                <div>
                  <span className="reg-badge">
                    {detail.shared
                      ? "SHARED OFFICIAL TEXT"
                      : "COMPANY REFERENCE"}
                  </span>
                  <p>
                    {detail.officialId || "No official ID"} ·{" "}
                    {detail.versionCount}{" "}
                    {detail.versionCount === 1 ? "version" : "versions"}
                  </p>
                </div>
                {editable && !detail.shared && (
                  <a
                    className="btn"
                    href={`${regulationLink(detail.id)}/upload`}
                  >
                    <Plus size={16} />
                    Add version
                  </a>
                )}
              </section>
              <h2 className="reg-section-title">Version history</h2>
              <p className="reg-muted">
                Newest first. Download the exact text used as evidence.
              </p>
              {detail.versions.length ? (
                detail.versions.map((version) => (
                  <DocumentCard key={version.id} document={version} />
                ))
              ) : (
                <section className="panel">
                  No documents have been uploaded yet.
                </section>
              )}
              <ErrorBoundary
                fallback={
                  <section className="panel reg-error" role="alert">
                    Couldn’t show this regulation’s market requirements.
                  </section>
                }
              >
                <RequirementReview
                  regulation={detail}
                  editable={editable}
                  owner={owner}
                />
              </ErrorBoundary>
            </>
          ) : (
            isList && (
              <>
                <div className="reg-stats">
                  <div>
                    <strong>{regulations.length}</strong>
                    <span>REGULATIONS</span>
                  </div>
                  <div>
                    <strong>
                      {regulations.filter((item) => item.shared).length}
                    </strong>
                    <span>SHARED TEXTS</span>
                  </div>
                  <div>
                    <strong>
                      {regulations.filter((item) => !item.shared).length}
                    </strong>
                    <span>COMPANY REFERENCES</span>
                  </div>
                </div>
                <div className="reg-toolbar">
                  <label className="search">
                    <Search size={17} />
                    <input
                      aria-label="Search regulations"
                      placeholder="Search title or official ID…"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </label>
                  <label>
                    Collection
                    <select
                      value={scope}
                      onChange={(event) => setScope(event.target.value)}
                    >
                      <option value="all">All regulations</option>
                      <option value="shared">Shared official texts</option>
                      <option value="company">Company references</option>
                    </select>
                  </label>
                </div>
                {!editable && (
                  <p className="reg-muted">
                    Read-only access. Company owners and editors can upload
                    documents.
                  </p>
                )}
                {filtered.length ? (
                  <div className="reg-grid">
                    {filtered.map((regulation) => (
                      <article className="reg-card" key={regulation.id}>
                        <div className="reg-card-top">
                          <FileText size={24} />
                          <span className="reg-badge">
                            {regulation.shared ? "SHARED" : "COMPANY"}
                          </span>
                        </div>
                        <p className="eyebrow">
                          {regulation.officialId || "COMPANY REFERENCE"}
                        </p>
                        <h2>
                          <a href={regulationLink(regulation.id)}>
                            {regulation.title}
                          </a>
                        </h2>
                        <p className="reg-muted">
                          {regulation.versionCount}{" "}
                          {regulation.versionCount === 1
                            ? "version"
                            : "versions"}
                          {regulation.latestVersion
                            ? ` · Updated ${timestamp(regulation.latestVersion.createdAt)}`
                            : ""}
                        </p>
                        <a
                          className="text-link"
                          href={regulationLink(regulation.id)}
                        >
                          View regulation <ArrowUpRight size={16} />
                        </a>
                      </article>
                    ))}
                  </div>
                ) : (
                  <section className="panel reg-empty">
                    <FileText size={30} />
                    <h2>
                      {regulations.length
                        ? "No matching regulations"
                        : "Your library is ready"}
                    </h2>
                    <p>
                      {regulations.length
                        ? "Try another title, official ID or collection."
                        : "Shared texts and uploaded company references will appear here."}
                    </p>
                  </section>
                )}
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
