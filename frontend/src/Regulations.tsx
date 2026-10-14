import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Download,
  FileText,
  Plus,
  Search,
  Upload,
} from "lucide-react";
import {
  api,
  type Regulation,
  type RegulationDetail,
  type RegulationDocument,
  type RequirementSource,
} from "./api";
import { errorMessage } from "./auth";
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
        Files are stored as references. Uploading does not extract requirements
        or run an analysis.
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
export default function RegulationsPage({
  live,
  editable,
  path,
}: {
  live: boolean;
  editable: boolean;
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
