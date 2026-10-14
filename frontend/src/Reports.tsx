import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Download,
  Eye,
  FileText,
  Loader2,
  Mail,
  Plus,
  RotateCcw,
  Save,
  Send,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  type ReportContent,
  type ReportDraft,
  type ReportRow,
  type ReportSection,
  type ReportSummary,
} from "./api";
import { errorMessage } from "./auth";
import "./reports.css";

const home = "#/workspace/reports";
const reportLink = (id: string) => `${home}/${encodeURIComponent(id)}`;
const day = (value: string) =>
  new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const WINDOWS = [7, 30, 90, 180];
const EMAIL = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;

type RowState = "edited" | "added" | "removed" | null;
const sameRow = (a: ReportRow, b: ReportRow) =>
  a.tone === b.tone && a.cells.join("\u0000") === b.cells.join("\u0000");

// Mirrors compare_report in backend/app/services/reports.py, so the editor shows what the PDF
// will mark before the draft is saved.
function rowState(row: ReportRow, original?: ReportRow): RowState {
  if (!original) return row.included ? "added" : null;
  if (original.included && !row.included) return "removed";
  return row.included && !sameRow(row, original) ? "edited" : null;
}
function countEdits(content: ReportContent, original: ReportContent) {
  let edited = 0;
  let added = 0;
  let removed = 0;
  let text = 0;
  content.sections.forEach((section, i) => {
    const before = original.sections[i];
    if (!before) return;
    if (before.included && !section.included) removed++;
    if (
      before.heading !== section.heading ||
      before.note !== section.note ||
      before.empty !== section.empty ||
      before.columns.join("\u0000") !== section.columns.join("\u0000")
    )
      text++;
    const old = new Map(before.rows.map((r) => [r.id, r]));
    for (const row of section.rows) {
      const state = rowState(row, old.get(row.id));
      if (state === "edited") edited++;
      else if (state === "added") added++;
      else if (state === "removed") removed++;
    }
  });
  const header =
    content.title !== original.title ||
    content.subtitle !== original.subtitle ||
    content.summary !== original.summary;
  return { edited, added, removed, text, header };
}
function editSummary(counts: ReturnType<typeof countEdits>) {
  const parts = [
    counts.header && "title or summary rewritten",
    counts.edited && `${counts.edited} line${counts.edited === 1 ? "" : "s"} changed`,
    counts.added && `${counts.added} added`,
    counts.removed && `${counts.removed} left out`,
    counts.text &&
      `${counts.text} section heading${counts.text === 1 ? "" : "s"} or note${counts.text === 1 ? "" : "s"} reworded`,
  ].filter(Boolean);
  return parts.join(" · ");
}

export default function ReportsPage({
  live,
  editable,
  path,
  notify,
}: {
  live: boolean;
  editable: boolean;
  path: string;
  notify: (text: string, error?: boolean) => void;
}) {
  const id = path.split("/").filter(Boolean)[0];
  return (
    <div className="report-page">
      {id && (
        <a className="text-link" href={home}>
          <ArrowLeft size={15} />
          All reports
        </a>
      )}
      {!live ? (
        <>
          <Heading />
          <section className="panel report-empty">
            <FileText size={30} />
            <h2>Sign in to your company workspace</h2>
            <p>
              Reports are built from your company’s orders, suppliers and
              regulations, so they need a connected workspace.
            </p>
            <a className="btn" href="#/login">
              Sign in
            </a>
          </section>
        </>
      ) : id ? (
        <ReportEditor
          key={id}
          id={id}
          editable={editable}
          notify={notify}
        />
      ) : (
        <ReportsHome />
      )}
    </div>
  );
}

function Heading({ action }: { action?: React.ReactNode }) {
  return (
    <header className="page-heading">
      <div>
        <div className="eyebrow">WHAT’S HAPPENING. WHAT IT AFFECTS.</div>
        <h1>Reports.</h1>
        <p>
          Generate a report, edit anything in it, preview the PDF, then send
          it. Edited lines stay marked in the PDF.
        </p>
      </div>
      {action}
    </header>
  );
}

function ReportsHome() {
  const [reports, setReports] = useState<ReportSummary[] | null>(null);
  const [error, setError] = useState("");
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api
      .reports(controller.signal)
      .then(setReports)
      .catch((e) => !controller.signal.aborted && setError(errorMessage(e)));
    return () => controller.abort();
  }, []);
  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const draft = await api.createReport({ kind: "company", days });
      location.hash = reportLink(draft.id).slice(1);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <>
      <Heading />
      <section className="panel report-generate">
        <div>
          <h2>Company report</h2>
          <p>
            What is happening (checklist changes in your markets, news alerts,
            floods near your suppliers and sites, new regulation versions) and
            what it affects: orders with document gaps and the suppliers behind
            them.
          </p>
        </div>
        <div className="report-generate-controls">
          <label htmlFor="report-window">Window</label>
          <select
            id="report-window"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {WINDOWS.map((d) => (
              <option key={d} value={d}>
                {d} days back and ahead
              </option>
            ))}
          </select>
          <button className="btn" disabled={busy} onClick={generate}>
            {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
            {busy ? "Generating…" : "Generate company report"}
          </button>
        </div>
        <p className="fine-print">
          Order reports are prepared from an order’s page.{" "}
          <a className="text-link" href="#/workspace/orders">
            Go to orders <ArrowUpRight size={13} />
          </a>
        </p>
      </section>
      {error && (
        <p className="report-error" role="alert">
          {error}
        </p>
      )}
      <section className="panel">
        <h2>Your reports</h2>
        {!reports ? (
          !error && <p role="status">Loading reports…</p>
        ) : !reports.length ? (
          <p className="fine-print">No reports yet.</p>
        ) : (
          <ul className="report-list">
            {reports.map((r) => (
              <li key={r.id}>
                <a href={reportLink(r.id)}>
                  <b>{r.title}</b>
                  <span>
                    {r.kind === "company"
                      ? `Company · ${r.scope.days} days`
                      : `Order ${r.scope.orderId}`}{" "}
                    · {day(r.createdAt)}
                  </span>
                </a>
                <span className={"report-badge" + (r.sentAt ? " sent" : "")}>
                  {r.sentAt ? `Sent ${day(r.sentAt)}` : "Draft"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ReportEditor({
  id,
  editable,
  notify,
}: {
  id: string;
  editable: boolean;
  notify: (text: string, error?: boolean) => void;
}) {
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [content, setContent] = useState<ReportContent | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "preview" | "download">("");
  const [preview, setPreview] = useState("");
  const [emailOpen, setEmailOpen] = useState(false);
  const pending = useRef(false);
  const load = async (signal?: AbortSignal) => {
    try {
      const result = await api.report(id, signal);
      if (signal?.aborted) return;
      setDraft(result);
      setContent(result.content);
    } catch (e) {
      if (!signal?.aborted) setError(errorMessage(e));
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [id]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);
  const dirty =
    !!draft &&
    !!content &&
    JSON.stringify(content) !== JSON.stringify(draft.content);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const counts = useMemo(
    () => (draft && content ? countEdits(content, draft.original) : null),
    [content, draft],
  );
  if (!draft || !content)
    return error ? (
      <section className="panel report-error" role="alert">
        <h2>Couldn’t load this report.</h2>
        <p>{error}</p>
      </section>
    ) : (
      <section className="panel" role="status">
        Loading report…
      </section>
    );
  const sent = !!draft.sentAt;

  // Every action works on the saved draft, so unsaved edits are saved first.
  async function run(kind: typeof busy, action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(kind);
    setError("");
    try {
      if (dirty && !sent) {
        const saved = await api.updateReport(id, content!);
        setDraft(saved);
        setContent(saved.content);
      }
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      pending.current = false;
      setBusy("");
    }
  }
  const showPreview = () =>
    run("preview", async () => {
      const blob = await api.reportPdf(id);
      setPreview(URL.createObjectURL(blob));
    });
  const updateSection = (index: number, change: Partial<ReportSection>) =>
    setContent((c) =>
      c && {
        ...c,
        sections: c.sections.map((s, i) => (i === index ? { ...s, ...change } : s)),
      },
    );
  const updateRow = (index: number, rowId: string, change: Partial<ReportRow> | null) =>
    setContent((c) =>
      c && {
        ...c,
        sections: c.sections.map((s, i) =>
          i !== index
            ? s
            : {
                ...s,
                rows:
                  change === null
                    ? s.rows.filter((r) => r.id !== rowId)
                    : s.rows.map((r) => (r.id === rowId ? { ...r, ...change } : r)),
              },
        ),
      },
    );
  const summaryText = counts ? editSummary(counts) : "";
  return (
    <>
      <header className="page-heading">
        <div>
          <div className="eyebrow">
            {draft.kind === "company" ? "COMPANY REPORT" : "ORDER REPORT"} ·{" "}
            {sent
              ? `SENT ${day(draft.sentAt!).toUpperCase()}`
              : "DRAFT"}
          </div>
          <h1>{content.title || "Untitled report"}</h1>
          <p>
            Generated {day(draft.createdAt)} for {draft.companyName}. Only you
            can see this draft.
          </p>
        </div>
      </header>
      <div className="report-toolbar" role="toolbar" aria-label="Report actions">
        {!sent && (
          <button
            className="btn secondary"
            disabled={!dirty || !!busy}
            onClick={() => run("save", async () => notify("Report saved."))}
          >
            {busy === "save" ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            {dirty ? "Save changes" : "Saved"}
          </button>
        )}
        <button className="btn secondary" disabled={!!busy} onClick={showPreview}>
          {busy === "preview" ? <Loader2 size={16} className="spin" /> : <Eye size={16} />}
          Preview PDF
        </button>
        <button
          className="btn secondary"
          disabled={!!busy}
          onClick={() => run("download", () => api.downloadReport(id))}
        >
          <Download size={16} />
          Download PDF
        </button>
        {!sent && (
          <button
            className="btn"
            disabled={!editable || !!busy}
            onClick={() => run("save", async () => setEmailOpen(true))}
          >
            <Mail size={16} />
            Email report
          </button>
        )}
      </div>
      {!editable && !sent && (
        <p className="fine-print">Only owners and editors can email reports.</p>
      )}
      {sent && (
        <div className="notice">
          Sent to {draft.sentTo?.join(", ")} on {day(draft.sentAt!)}. A sent
          report is locked, so it stays what the recipients received.
        </div>
      )}
      {error && (
        <p className="report-error" role="alert">
          {error}
        </p>
      )}
      <p className="report-edits" aria-live="polite">
        {summaryText
          ? `Your edits: ${summaryText}. The PDF shades edited lines and names you as the editor.`
          : "No edits yet. Everything below can be changed; the PDF marks what you change."}
      </p>
      {preview && (
        <section className="panel report-preview" aria-label="PDF preview">
          <div className="report-preview-bar">
            <h2>Preview</h2>
            <a className="text-link" href={preview} target="_blank" rel="noreferrer">
              Open in a new tab <ArrowUpRight size={13} />
            </a>
            <button
              className="icon-btn"
              aria-label="Close preview"
              onClick={() => setPreview("")}
            >
              <X size={18} />
            </button>
          </div>
          <iframe title="Report PDF preview" src={preview} />
          <p className="fine-print">
            Preview blank? Some phone browsers can’t show a PDF inside a page;
            open it in a new tab instead.
          </p>
        </section>
      )}
      <fieldset className="report-form-body" disabled={sent}>
        <section className="panel report-header-fields">
          <label htmlFor="report-title">Title</label>
          <input
            id="report-title"
            maxLength={200}
            value={content.title}
            onChange={(e) => setContent({ ...content, title: e.target.value })}
          />
          <label htmlFor="report-subtitle">Subtitle</label>
          <input
            id="report-subtitle"
            maxLength={300}
            value={content.subtitle}
            onChange={(e) => setContent({ ...content, subtitle: e.target.value })}
          />
          <label htmlFor="report-summary">Summary</label>
          <textarea
            id="report-summary"
            maxLength={6000}
            value={content.summary}
            onChange={(e) => setContent({ ...content, summary: e.target.value })}
          />
        </section>
        {content.sections.map((section, index) => (
          <SectionEditor
            key={section.id}
            section={section}
            original={draft.original.sections[index]}
            onChange={(change) => updateSection(index, change)}
            onRow={(rowId, change) => updateRow(index, rowId, change)}
          />
        ))}
      </fieldset>
      {emailOpen && (
        <EmailDialog
          draft={draft}
          onClose={() => setEmailOpen(false)}
          onSent={(text) => {
            setEmailOpen(false);
            notify(text);
            void load();
          }}
        />
      )}
    </>
  );
}

function SectionEditor({
  section,
  original,
  onChange,
  onRow,
}: {
  section: ReportSection;
  original: ReportSection;
  onChange: (change: Partial<ReportSection>) => void;
  onRow: (rowId: string, change: Partial<ReportRow> | null) => void;
}) {
  const originals = new Map(original.rows.map((r) => [r.id, r]));
  // A column is wide when the generated report has long text in it. Decided once, so a field
  // never turns from an input into a textarea (and loses focus) while someone types.
  const wide = section.columns.map((_, i) =>
    original.rows.some((r) => r.cells[i]?.length > 28 || r.cells[i]?.includes("\n")),
  );
  const fieldId = (suffix: string) => `report-${section.id}-${suffix}`;
  return (
    <section
      className={"panel report-section" + (section.included ? "" : " left-out")}
      aria-label={section.heading || section.id}
    >
      <div className="report-section-head">
        <label className="report-check">
          <input
            type="checkbox"
            checked={section.included}
            onChange={(e) => onChange({ included: e.target.checked })}
          />
          Include section
        </label>
      </div>
      <label htmlFor={fieldId("heading")}>Section heading</label>
      <input
        id={fieldId("heading")}
        className="report-heading-input"
        maxLength={200}
        value={section.heading}
        onChange={(e) => onChange({ heading: e.target.value })}
      />
      <label htmlFor={fieldId("note")}>Introduction</label>
      <textarea
        id={fieldId("note")}
        className="report-note"
        maxLength={4000}
        value={section.note}
        onChange={(e) => onChange({ note: e.target.value })}
      />
      {section.included && (
        <>
          {!section.rows.length && (
            <p className="fine-print">{section.empty || "Nothing to report."}</p>
          )}
          <ol className="report-rows">
            {section.rows.map((row) => {
              const before = originals.get(row.id);
              const state = rowState(row, before);
              return (
                <li key={row.id} className={"report-row " + (state || "")}>
                  <div className="report-row-head">
                    {state && (
                      <span className={"report-badge " + state}>
                        {state === "removed" ? "Left out" : state[0].toUpperCase() + state.slice(1)}
                      </span>
                    )}
                    <span className="report-row-actions">
                      {section.layout !== "sources" && row.included && (
                        <select
                          aria-label="Highlight"
                          value={row.tone || ""}
                          onChange={(e) =>
                            onRow(row.id, {
                              tone: (e.target.value || null) as ReportRow["tone"],
                            })
                          }
                        >
                          <option value="">No highlight</option>
                          <option value="warn">Warning</option>
                          <option value="gap">Gap</option>
                        </select>
                      )}
                      {state === "edited" && before && (
                        <button
                          type="button"
                          className="text-link"
                          onClick={() => onRow(row.id, { cells: before.cells, tone: before.tone })}
                        >
                          <RotateCcw size={13} /> Undo changes
                        </button>
                      )}
                      {before ? (
                        <button
                          type="button"
                          className="text-link"
                          onClick={() => onRow(row.id, { included: !row.included })}
                        >
                          {row.included ? (
                            <>
                              <X size={13} /> Leave out
                            </>
                          ) : (
                            <>
                              <Plus size={13} /> Include again
                            </>
                          )}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="text-link"
                          onClick={() => onRow(row.id, null)}
                        >
                          <Trash2 size={13} /> Delete line
                        </button>
                      )}
                    </span>
                  </div>
                  {row.included && (
                    <div className={"report-cells " + section.layout}>
                      {row.cells.map((cell, i) => {
                        const cellId = `${fieldId(row.id)}-${i}`;
                        const long = wide[i];
                        const change = (value: string) =>
                          onRow(row.id, {
                            cells: row.cells.map((c, j) => (j === i ? value : c)),
                          });
                        return (
                          <div key={i} className={long ? "wide" : ""}>
                            <label htmlFor={cellId}>{section.columns[i]}</label>
                            {long ? (
                              <textarea
                                id={cellId}
                                maxLength={4000}
                                rows={Math.min(8, Math.max(2, Math.ceil(cell.length / 90) + cell.split("\n").length - 1))}
                                value={cell}
                                onChange={(e) => change(e.target.value)}
                              />
                            ) : (
                              <input
                                id={cellId}
                                maxLength={4000}
                                value={cell}
                                onChange={(e) => change(e.target.value)}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            className="btn secondary report-add"
            onClick={() =>
              onChange({
                rows: [
                  ...section.rows,
                  {
                    id: `added-${crypto.randomUUID().slice(0, 8)}`,
                    cells: section.columns.map(() => ""),
                    tone: null,
                    included: true,
                  },
                ],
              })
            }
          >
            <Plus size={15} /> Add line
          </button>
        </>
      )}
    </section>
  );
}

function EmailDialog({
  draft,
  onClose,
  onSent,
}: {
  draft: ReportDraft;
  onClose: () => void;
  onSent: (text: string) => void;
}) {
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // New per dialog: resubmitting the same dialog sends the email once.
  const key = useRef(crypto.randomUUID());
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>("#report-to")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);
  const send = async () => {
    const recipients = to.split(/[\s,;]+/).filter(Boolean);
    const invalid = recipients.find((a) => !EMAIL.test(a));
    if (!recipients.length || invalid || recipients.length > 5) {
      setError(
        invalid
          ? `“${invalid}” is not an email address.`
          : recipients.length > 5
            ? "Send to five addresses at most."
            : "Add at least one email address.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const sent = await api.emailReport(
        draft.id,
        { to: recipients, message: note },
        key.current,
      );
      onSent(
        sent.sandbox
          ? `Sandbox: the report email to ${sent.recipients.join(", ")} was recorded but not delivered.`
          : `Report emailed to ${sent.recipients.join(", ")}.`,
      );
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-email-title"
        ref={dialog}
      >
        <button className="modal-close icon-btn" aria-label="Close dialog" onClick={onClose}>
          <X size={20} />
        </button>
        <form
          className="report-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void send();
          }}
        >
          <span className="eyebrow">SHARE THE PAPER TRAIL.</span>
          <h2 id="report-email-title">Email this report.</h2>
          <p>
            The PDF you previewed goes as an attachment. Replies come to your
            own address. After sending, the report is locked and the send is
            kept in your company’s audit log.
          </p>
          <label htmlFor="report-to">To</label>
          <input
            id="report-to"
            type="text"
            inputMode="email"
            autoComplete="email"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setError("");
            }}
            placeholder="buyer@example.com, broker@example.com"
          />
          <small>Up to five addresses, separated by commas.</small>
          <label htmlFor="report-note">Message (optional)</label>
          <textarea
            id="report-note"
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="For example: Here is where our shipments stand this month."
          />
          {error && (
            <p className="report-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn" type="submit" disabled={busy || !to.trim()}>
            {busy ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
            {busy ? "Sending…" : "Send report"}
          </button>
        </form>
      </div>
    </div>
  );
}
