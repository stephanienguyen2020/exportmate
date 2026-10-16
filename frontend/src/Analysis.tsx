// Phase 2/3 analysis screens for a signed-in company: the run panel on the Orders page and,
// on an order's page, its latest analysis report, the owner's review, feedback, HS code
// suggestions, suggested solutions (Solutions.tsx) and supplier messages. Every number and quote comes from the backend.
import { useEffect, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  Loader2,
  Play,
  Send,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import {
  api,
  type AnalysisReport,
  type AnalysisRun,
  type CostLine,
  type HsSuggestion,
  type ReportState,
  type SupplierMessage,
} from "./api";
import { errorMessage } from "./auth";
import { CostWhy } from "./CostWhy";
import NextMoves, { type OrderField } from "./NextMoves";
import { documentLink, RegulationCitation } from "./Regulations";
import Solutions from "./Solutions";
import "./analysis.css";

type Role = "owner" | "editor" | "viewer" | null;
type Notify = (text: string, error?: boolean) => void;

// Amounts are hundredths of the currency unit for every currency, JPY and VND included.
export const exactMoney = (minor: number, currency: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(minor / 100);
const totals = (byCurrency: Record<string, number>) =>
  Object.entries(byCurrency)
    .map(([code, minor]) => exactMoney(minor, code))
    .join(" + ") || "—";
// The hover note on a cost line: the sum, then where each number in it came from.
function CostLineWhy({ line }: { line: CostLine }) {
  return (
    <>
      <span>
        <b>{line.formula}</b> = {exactMoney(line.amountMinor, line.currency)}
      </span>
      {line.basis.map((basis, i) =>
        basis.source ? (
          <span key={i}>
            Rate set by {basis.source.officialId || basis.source.regulationTitle}{" "}
            v{basis.source.versionNumber}: <q>{basis.source.quote}</q>{" "}
            <a href={documentLink(basis.source.documentId)}>View the text</a>
          </span>
        ) : (
          <span key={i}>
            {basis.type === "company_setting"
              ? "Your cost setting: "
              : "ExportMate's default, until you set your own: "}
            {basis.label}. Set under Account › Cost settings.
          </span>
        ),
      )}
    </>
  );
}
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const day = (iso: string) =>
  new Date(iso + "T12:00:00").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const orderLink = (id: string) =>
  "#/workspace/orders/" + encodeURIComponent(id);

const STATE: Record<ReportState, { label: string; tone: string }> = {
  pass: { label: "Checked", tone: "green" },
  needs_data: { label: "Needs data", tone: "amber" },
  rejected: { label: "Rejected by the auditor", tone: "red" },
  needs_human_review: { label: "Waiting for the owner's review", tone: "amber" },
};
const ORDER_STATUS: Record<string, string> = {
  clear: "In the clear",
  exposed: "Action needed",
  needs_data: "Needs data",
  awaiting_analysis: "Awaiting analysis",
};
const STEP_LABEL: Record<AnalysisRun["steps"][number]["name"], string> = {
  relevance: "Relevance",
  exposure: "Exposure",
  cost: "Cost",
  playbook: "Playbook",
  plan: "Plan",
  auditor: "Auditor",
};
const ACTION_LABEL: Record<string, string> = {
  flag: "Note on the report",
  owner_review: "Owner review",
  block: "Blocks supplier messages",
};
const GAPS = new Set(["missing", "mismatch"]);

function StateBadge({ state }: { state: ReportState }) {
  return (
    <span className={`status ${STATE[state].tone}`}>
      <i />
      {STATE[state].label}
    </span>
  );
}

// One action at a time; errors go to the caller's toast.
function useAction(notify: Notify) {
  const [busy, setBusy] = useState("");
  const pending = useRef(false);
  const act = async (name: string, action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(name);
    try {
      await action();
    } catch (error) {
      notify(errorMessage(error), true);
    } finally {
      pending.current = false;
      setBusy("");
    }
  };
  return { busy, act };
}

/** Orders page: analyse every order, then show what each step did and each order's result. */
export function RunPanel({
  editable,
  pending,
  lastRun,
  onFinished,
  notify,
}: {
  editable: boolean;
  pending: number;
  // A run started elsewhere (the CSV import), shown until this panel starts its own.
  lastRun: AnalysisRun | null;
  onFinished: () => Promise<void>;
  notify: Notify;
}) {
  const [run, setRun] = useState<AnalysisRun | null>(lastRun);
  useEffect(() => {
    if (lastRun) setRun(lastRun);
  }, [lastRun]);
  const { busy, act } = useAction(notify);
  const start = () =>
    act("run", async () => {
      const result = await api.startRun();
      setRun(result);
      await onFinished();
      notify(
        result.status === "failed"
          ? result.error || "The analysis failed."
          : `${result.orderCount} orders analysed.`,
        result.status === "failed",
      );
    });
  return (
    <section className="panel an-run" aria-label="Analysis">
      <div className="an-run-head">
        <div>
          <span className="eyebrow">ANALYSIS</span>
          <h2>Check every order against its market.</h2>
          <p>
            Each order is matched to its market checklist, priced with your cost
            settings, run through your checked playbook rules and audited.
            {pending > 0 &&
              ` ${pending} ${pending === 1 ? "order is" : "orders are"} awaiting analysis.`}
          </p>
        </div>
        {editable ? (
          <button className="btn" disabled={!!busy} onClick={start}>
            {busy ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
            {busy ? "Analysing…" : "Analyse orders"}
          </button>
        ) : (
          <p className="fine-print">Owners and editors can start an analysis.</p>
        )}
      </div>
      {run && (
        <div className="an-run-result">
          <ol className="an-steps">
            {run.steps.map((step) => (
              <li key={step.name}>
                <Check size={13} />
                <b>{STEP_LABEL[step.name]}</b>
                <span>{step.summary}</span>
              </li>
            ))}
          </ol>
          {run.error && (
            <p className="an-error" role="alert">
              {run.error}
            </p>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Status</th>
                  <th>Report</th>
                  <th>Estimated cost</th>
                </tr>
              </thead>
              <tbody>
                {run.reports.map((report) => (
                  <tr key={report.id}>
                    <td>
                      <a className="order-link" href={orderLink(report.orderId)}>
                        {report.orderId}
                      </a>
                    </td>
                    <td>
                      {ORDER_STATUS[report.orderStatus]}
                      {report.missingData.length > 0 && (
                        <ul className="an-missing">
                          {report.missingData.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td>
                      <StateBadge state={report.state} />
                      {report.blocked && (
                        <small className="an-blocked">messages blocked</small>
                      )}
                    </td>
                    <td className="mono">
                      {Object.keys(report.costTotals).length ? (
                        <CostWhy why="The sum of this order's cost lines. Open the order to see where each one comes from.">
                          {totals(report.costTotals)}
                        </CostWhy>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fine-print">
            Run {run.id.slice(0, 8)} · {when(run.createdAt)} · playbook revision{" "}
            {run.playbookRevision}
          </p>
        </div>
      )}
    </section>
  );
}

/** Order page: the order's latest analysis and what can be done with it. */
export default function OrderAnalysis({
  orderId,
  hsCode,
  latestReportId,
  role,
  onChanged,
  onEditOrder,
  notify,
}: {
  orderId: string;
  hsCode: string;
  latestReportId: string | null;
  role: Role;
  onChanged: () => Promise<void>;
  // Opens the order's own form at a field, for a next move that changes the order.
  onEditOrder?: (field: OrderField) => void;
  notify: Notify;
}) {
  const editable = role === "owner" || role === "editor";
  const [reportId, setReportId] = useState(latestReportId);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [error, setError] = useState("");
  const { busy, act } = useAction(notify);
  useEffect(() => setReportId(latestReportId), [latestReportId]);
  useEffect(() => {
    setReport(null);
    setError("");
    if (!reportId) return;
    const controller = new AbortController();
    api
      .analysisReport(reportId, controller.signal)
      .then((value) => !controller.signal.aborted && setReport(value))
      .catch(
        (e) => !controller.signal.aborted && setError(errorMessage(e)),
      );
    return () => controller.abort();
  }, [reportId]);
  const showRun = async (run: AnalysisRun) => {
    const next = run.reports.find((r) => r.orderId === orderId);
    if (next) setReportId(next.id);
    await onChanged();
  };
  const analyse = () =>
    act("run", async () => {
      const run = await api.startRun([orderId]);
      if (run.status === "failed")
        throw new Error(run.error || "The analysis failed.");
      await showRun(run);
      notify(`${orderId} analysed.`);
    });

  return (
    <>
      {!hsCode && (
        <HsSuggestions
          orderId={orderId}
          editable={editable}
          notify={notify}
          onAccepted={showRun}
        />
      )}
      <section className="panel an-report" aria-label="Analysis report">
        <div className="an-report-head">
          <div>
            <span className="eyebrow">ANALYSIS REPORT</span>
            <h2>
              {report
                ? report.suggestedAction.text
                : reportId
                  ? "Loading the analysis…"
                  : "Not analysed yet."}
            </h2>
          </div>
          {editable && (
            <button
              className="btn secondary"
              disabled={!!busy}
              onClick={analyse}
            >
              {busy === "run" ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Play size={15} />
              )}
              {reportId ? "Analyse again" : "Analyse this order"}
            </button>
          )}
        </div>
        {report && editable && onEditOrder && (
          <NextMoves
            report={report}
            notify={notify}
            onEditOrder={onEditOrder}
            onAskSupplier={() =>
              document
                .getElementById("supplier-messages")
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
            onChanged={onChanged}
          />
        )}
        {error ? (
          <p role="alert">{error}</p>
        ) : !reportId ? (
          <p>
            Analysis checks this order against its market checklist, prices
            what's missing with your cost settings, applies your checked
            playbook rules and audits the result.
            {!editable && " Owners and editors can start it."}
          </p>
        ) : !report ? (
          <p role="status">
            <Loader2 size={15} className="spin" /> Loading…
          </p>
        ) : (
          <ReportBody
            report={report}
            role={role}
            notify={notify}
            onReviewed={(next) => {
              setReport(next);
              void onChanged();
            }}
          />
        )}
      </section>
      {report && <Solutions report={report} role={role} notify={notify} />}
      {report && (
        <SupplierMessages
          orderId={orderId}
          report={report}
          role={role}
          notify={notify}
        />
      )}
    </>
  );
}

function ReportBody({
  report,
  role,
  notify,
  onReviewed,
}: {
  report: AnalysisReport;
  role: Role;
  notify: Notify;
  onReviewed: (report: AnalysisReport) => void;
}) {
  const problems = report.findings.filter((f) => GAPS.has(f.status));
  const others = report.findings.filter((f) => !GAPS.has(f.status));
  return (
    <>
      <div className="an-meta">
        <StateBadge state={report.state} />
        <span>
          {report.market || "No market"} ·{" "}
          {report.daysUntilShip >= 0
            ? `${report.daysUntilShip} days until it ships`
            : `shipped ${-report.daysUntilShip} days ago`}{" "}
          · analysed {when(report.createdAt)}
        </span>
      </div>
      {report.suggestedAction.requestBy && (
        <p className="an-callout">
          Ask the supplier by <b>{day(report.suggestedAction.requestBy)}</b>,
          given their usual lead time.
        </p>
      )}
      <OwnerReview report={report} role={role} notify={notify} onReviewed={onReviewed} />
      {report.missingData.length > 0 && (
        <>
          <h3>Data to complete</h3>
          <ul className="an-list">
            {report.missingData.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </>
      )}
      <h3>
        Problems{" "}
        <small>
          {problems.length} of {report.findings.length} checks
        </small>
      </h3>
      {problems.length ? (
        <ul className="an-findings">
          {problems.map((f) => (
            <li key={f.requirementKey}>
              <span className="status red">
                <i />
                {f.status === "missing" ? "Missing" : "Doesn't match"}
              </span>
              <div>
                <b>{f.title}</b>
                <p>{f.note}</p>
                <RegulationCitation source={f.source} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p>No document is missing or out of date for this order's checklist.</p>
      )}
      {others.length > 0 && (
        <details className="an-details">
          <summary>The other {others.length} checks</summary>
          <ul className="an-findings">
            {others.map((f) => (
              <li key={f.requirementKey}>
                <span className="status">
                  <i />
                  {f.status.replace("_", " ")}
                </span>
                <div>
                  <b>{f.title}</b>
                  <p>{f.note}</p>
                  <RegulationCitation source={f.source} />
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
      <h3>Estimated cost</h3>
      {report.costLines.length ? (
        <>
          {report.costLines.map((line, i) => (
            <div className="an-cost" key={i}>
              <div>
                <span>{line.label}</span>
              </div>
              <b className="mono">
                <CostWhy why={<CostLineWhy line={line} />}>
                  {exactMoney(line.amountMinor, line.currency)}
                </CostWhy>
              </b>
            </div>
          ))}
          <div className="cost-row total">
            <span>Total</span>
            <b>
              <CostWhy
                why={`The sum of the ${report.costLines.length} lines above, per currency. Hover a line to see where its numbers come from.`}
              >
                {totals(report.costTotals)}
              </CostWhy>
            </b>
          </div>
        </>
      ) : (
        <p>No costs for this order.</p>
      )}
      {report.unpricedCosts.map((cost) => (
        <div className="an-cost unpriced" key={cost.requirementKey}>
          <div>
            <span>{cost.label}</span>
            <small>{cost.reason}</small>
            <RegulationCitation source={cost.source} />
          </div>
          <b>Not priced</b>
        </div>
      ))}
      <p className="fine-print">
        Estimates from your cost settings and the official texts cited; hover
        an amount to see how it was worked out. Order value is not included.
      </p>
      <h3>Playbook rules</h3>
      {report.rulesFired.length ? (
        <ul className="an-list">
          {report.rulesFired.map((rule) => (
            <li key={rule.ruleId}>
              <b>{rule.text}</b> → {ACTION_LABEL[rule.action] || rule.action}
              {rule.note && <> · {rule.note}</>}
              <small>When {rule.conditions.join(" and ")}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p>None of your checked rules applies to this order.</p>
      )}
      {report.rulesNotChecked > 0 && (
        <p className="fine-print">
          {report.rulesNotChecked} switched-on{" "}
          {report.rulesNotChecked === 1 ? "rule has" : "rules have"} no
          conditions, so analysis can't check{" "}
          {report.rulesNotChecked === 1 ? "it" : "them"}.{" "}
          <a className="text-link" href="#/workspace/playbook">
            Add conditions
          </a>
        </p>
      )}
      <h3>Audit</h3>
      {report.audit.passed ? (
        <p className="an-ok">
          <ShieldCheck size={15} /> Every claim is cited and every number
          re-computes.
        </p>
      ) : (
        <ul className="an-list an-error">
          {report.audit.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <Feedback report={report} notify={notify} />
    </>
  );
}

function OwnerReview({
  report,
  role,
  notify,
  onReviewed,
}: {
  report: AnalysisReport;
  role: Role;
  notify: Notify;
  onReviewed: (report: AnalysisReport) => void;
}) {
  const [note, setNote] = useState("");
  const { busy, act } = useAction(notify);
  if (report.review)
    return (
      <p className="an-callout">
        <Check size={15} /> Reviewed by {report.review.reviewedBy.name} on{" "}
        {when(report.review.reviewedAt)}
        {report.review.note ? `: “${report.review.note}”` : "."}
      </p>
    );
  if (report.state !== "needs_human_review") return null;
  return (
    <div className="an-review" role="group" aria-label="Owner review">
      <p>
        <CircleAlert size={15} /> A playbook rule or the auditor sent this
        report to the owner. No supplier message can be drafted until it's
        reviewed.
      </p>
      {role === "owner" && (
        <>
          <label htmlFor="an-review-note">Note (optional)</label>
          <input
            id="an-review-note"
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            className="btn"
            disabled={!!busy}
            onClick={() =>
              act("review", async () => {
                onReviewed(
                  await api.reviewReport(report.id, note.trim() || null),
                );
                notify("Report reviewed. You can now contact the supplier.");
              })
            }
          >
            <Check size={15} />
            Reviewed: OK to contact the supplier
          </button>
        </>
      )}
    </div>
  );
}

function Feedback({ report, notify }: { report: AnalysisReport; notify: Notify }) {
  const [feedback, setFeedback] = useState(report.feedback ?? null);
  const [note, setNote] = useState(report.feedback?.myNote ?? "");
  const [choice, setChoice] = useState<boolean | null>(null);
  const { busy, act } = useAction(notify);
  const send = (useful: boolean) =>
    act("feedback", async () => {
      setFeedback(await api.reportFeedback(report.id, useful, note.trim() || null));
      setChoice(null);
      notify("Thanks for the feedback.");
    });
  return (
    <div className="an-feedback">
      <span>Was this analysis useful?</span>
      <button
        className={"icon-btn" + (feedback?.mine === true ? " on" : "")}
        aria-label="Useful"
        aria-pressed={feedback?.mine === true}
        disabled={!!busy}
        onClick={() => setChoice(true)}
      >
        <ThumbsUp size={15} />
        {feedback ? feedback.useful : ""}
      </button>
      <button
        className={"icon-btn" + (feedback?.mine === false ? " on" : "")}
        aria-label="Not useful"
        aria-pressed={feedback?.mine === false}
        disabled={!!busy}
        onClick={() => setChoice(false)}
      >
        <ThumbsDown size={15} />
        {feedback ? feedback.notUseful : ""}
      </button>
      {choice !== null && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(choice);
          }}
        >
          <input
            aria-label="Feedback note (optional)"
            placeholder={choice ? "What helped? (optional)" : "What was wrong? (optional)"}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button className="btn secondary" type="submit" disabled={!!busy}>
            Send feedback
          </button>
        </form>
      )}
    </div>
  );
}

function HsSuggestions({
  orderId,
  editable,
  notify,
  onAccepted,
}: {
  orderId: string;
  editable: boolean;
  notify: Notify;
  onAccepted: (run: AnalysisRun) => Promise<void>;
}) {
  const [suggestions, setSuggestions] = useState<HsSuggestion[] | null>(null);
  const { busy, act } = useAction(notify);
  useEffect(() => {
    const controller = new AbortController();
    api
      .hsSuggestions(orderId, controller.signal)
      .then((value) => !controller.signal.aborted && setSuggestions(value))
      .catch(() => !controller.signal.aborted && setSuggestions([]));
    return () => controller.abort();
  }, [orderId]);
  const pending = (suggestions || []).filter((s) => s.status === "pending");
  const decided = (suggestions || []).filter((s) => s.status !== "pending");
  const replace = (next: HsSuggestion) =>
    setSuggestions((all) => (all || []).map((s) => (s.id === next.id ? next : s)));
  return (
    <section className="panel an-hs" aria-label="HS code suggestions">
      <span className="eyebrow">NO HS CODE</span>
      <h2>This order has no HS code.</h2>
      <p>
        Without one, its market checklist and duties can't be matched. AI can
        suggest codes from your past orders and the official tariff lines
        closest to “{orderId}”'s product; you decide.
      </p>
      {editable && !pending.length && (
        <button
          className="btn"
          disabled={!!busy}
          onClick={() =>
            act("suggest", async () => {
              const fresh = await api.suggestHsCodes(orderId);
              setSuggestions((all) => [
                ...fresh,
                ...(all || []).filter((s) => !fresh.some((f) => f.id === s.id)),
              ]);
            })
          }
        >
          {busy === "suggest" ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <Sparkles size={15} />
          )}
          Suggest HS code
        </button>
      )}
      {pending.length > 0 && (
        <div className="an-hs-cards">
          {pending.map((s) => (
            <article key={s.id} className="an-hs-card">
              <b className="mono">{s.hsCode}</b>
              <p className="an-hs-desc">{s.description}</p>
              <p>{s.reason}</p>
              <small>
                Based on{" "}
                {s.basedOn
                  .map((b) =>
                    b.type === "order"
                      ? `${b.ref} (${b.text}${b.hsCode ? `, ${b.hsCode}` : ""})`
                      : `tariff line ${b.ref}: ${b.text}`,
                  )
                  .join("; ")}
              </small>
              {editable && (
                <div className="an-actions">
                  <button
                    className="btn"
                    disabled={!!busy}
                    onClick={() =>
                      act("accept", async () => {
                        const result = await api.acceptHsSuggestion(s.id);
                        notify(
                          `${orderId} now has HS code ${result.order.hsCode} and was analysed again.`,
                        );
                        await onAccepted(result.run);
                      })
                    }
                  >
                    <Check size={15} />
                    Accept {s.hsCode}
                  </button>
                  <button
                    className="text-link"
                    disabled={!!busy}
                    onClick={() =>
                      act("reject", async () =>
                        replace(await api.rejectHsSuggestion(s.id)),
                      )
                    }
                  >
                    <X size={14} />
                    Reject
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {decided.length > 0 && (
        <p className="fine-print">
          Earlier suggestions:{" "}
          {decided.map((s) => `${s.hsCode} (${s.status})`).join(", ")}
        </p>
      )}
    </section>
  );
}

const MESSAGE_STATUS: Record<SupplierMessage["status"], string> = {
  draft: "Draft",
  approved: "Approved",
  sent: "Sent",
  failed: "Not delivered",
};

function SupplierMessages({
  orderId,
  report,
  role,
  notify,
}: {
  orderId: string;
  report: AnalysisReport;
  role: Role;
  notify: Notify;
}) {
  const editable = role === "owner" || role === "editor";
  const [messages, setMessages] = useState<SupplierMessage[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const { busy, act } = useAction(notify);
  useEffect(() => {
    const controller = new AbortController();
    api
      .supplierMessages(orderId, controller.signal)
      .then((value) => !controller.signal.aborted && setMessages(value))
      .catch(
        (e) => !controller.signal.aborted && setLoadError(errorMessage(e)),
      );
    return () => controller.abort();
  }, [orderId]);
  const replace = (next: SupplierMessage) =>
    setMessages((all) => [
      next,
      ...(all || []).filter((m) => m.id !== next.id),
    ]);
  const blocked = report.messageBlockedReason;
  return (
    <section
      id="supplier-messages"
      className="panel an-messages"
      aria-label="Supplier messages"
    >
      <div className="an-report-head">
        <div>
          <span className="eyebrow">YOUR NEXT MOVE</span>
          <h2>Email the supplier.</h2>
        </div>
        {editable && (
          <button
            className="btn"
            disabled={!!busy || !!blocked}
            title={blocked || undefined}
            onClick={() =>
              act("draft", async () => {
                replace(await api.draftSupplierMessage(report.id));
              })
            }
          >
            {busy === "draft" ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Send size={15} />
            )}
            Draft email to supplier
          </button>
        )}
      </div>
      {blocked ? (
        <p className="an-callout">
          <CircleAlert size={15} /> {blocked}
        </p>
      ) : (
        <p>
          AI drafts a request for the missing documents from this report. An
          editor checks it, the owner approves the exact text, then the owner
          sends it.
        </p>
      )}
      {loadError && <p role="alert">{loadError}</p>}
      {(messages || []).map((message) => (
        <MessageEditor
          key={message.id}
          message={message}
          role={role}
          notify={notify}
          onChange={replace}
        />
      ))}
    </section>
  );
}

function MessageEditor({
  message,
  role,
  notify,
  onChange,
}: {
  message: SupplierMessage;
  role: Role;
  notify: Notify;
  onChange: (message: SupplierMessage) => void;
}) {
  const editable =
    (role === "owner" || role === "editor") && message.status !== "sent";
  const [recipient, setRecipient] = useState(message.recipient ?? "");
  const [subject, setSubject] = useState(message.subject);
  const [body, setBody] = useState(message.body);
  const [saveToSupplier, setSaveToSupplier] = useState(false);
  // One key per message until it's sent: a retry or a double click sends once.
  const sendKey = useRef(crypto.randomUUID());
  const { busy, act } = useAction(notify);
  const dirty =
    recipient.trim() !== (message.recipient ?? "") ||
    subject !== message.subject ||
    body !== message.body;
  const id = `msg-${message.id}`;
  const save = () =>
    act("save", async () => {
      onChange(
        await api.updateSupplierMessage(message.id, {
          recipient: recipient.trim() || null,
          subject,
          body,
          saveRecipientToSupplier: saveToSupplier,
        }),
      );
      setSaveToSupplier(false);
      notify(
        message.status === "approved"
          ? "Saved. The message changed, so it needs the owner's approval again."
          : "Message saved.",
      );
    });
  return (
    <article className="an-message">
      <div className="an-meta">
        <span
          className={`status ${message.status === "sent" ? "green" : message.status === "failed" ? "red" : "amber"}`}
        >
          <i />
          {MESSAGE_STATUS[message.status]}
          {message.sandbox && " · sandbox"}
        </span>
        <span>
          Drafted by {message.createdBy.name} · {when(message.createdAt)}
          {message.approvedBy &&
            ` · approved by ${message.approvedBy.name}${message.approvedByAuthor ? " (who also drafted it)" : ""}`}
          {message.sentAt && ` · sent ${when(message.sentAt)}`}
        </span>
      </div>
      {message.sandbox && (
        <p className="fine-print">
          Sandbox: recorded, but no email was delivered.
        </p>
      )}
      {message.error && (
        <p className="an-error" role="alert">
          {message.error}
        </p>
      )}
      <fieldset disabled={!editable || !!busy}>
        <label htmlFor={id + "-to"}>To</label>
        <input
          id={id + "-to"}
          type="email"
          maxLength={254}
          value={recipient}
          placeholder="supplier@example.com"
          onChange={(e) => setRecipient(e.target.value)}
        />
        {editable && (
          <label className="an-check">
            <input
              type="checkbox"
              checked={saveToSupplier}
              onChange={(e) => setSaveToSupplier(e.target.checked)}
            />
            Save as the supplier's email
          </label>
        )}
        <label htmlFor={id + "-subject"}>Subject</label>
        <input
          id={id + "-subject"}
          maxLength={200}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
        <label htmlFor={id + "-body"}>Message</label>
        <textarea
          id={id + "-body"}
          rows={10}
          maxLength={5000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </fieldset>
      {message.status !== "sent" && (
        <div className="an-actions">
          {editable && (
            <button
              className="btn secondary"
              disabled={!!busy || (!dirty && !saveToSupplier)}
              onClick={save}
            >
              Save changes
            </button>
          )}
          {role === "owner" && message.status === "draft" && (
            <button
              className="btn"
              disabled={!!busy || dirty || !message.recipient}
              title={
                dirty
                  ? "Save your changes first"
                  : !message.recipient
                    ? "Add a recipient first"
                    : undefined
              }
              onClick={() =>
                act("approve", async () => {
                  onChange(await api.approveSupplierMessage(message.id));
                  notify("Approved. You can send it now.");
                })
              }
            >
              <Check size={15} />
              Approve
            </button>
          )}
          {role === "owner" &&
            (message.status === "approved" || message.status === "failed") && (
              <button
                className="btn"
                disabled={!!busy || dirty}
                onClick={() =>
                  act("send", async () => {
                    const sent = await api.sendSupplierMessage(
                      message.id,
                      sendKey.current,
                    );
                    onChange(sent);
                    notify(
                      sent.sandbox
                        ? `Sandbox: the message to ${sent.recipient} was recorded but not delivered.`
                        : `Sent to ${sent.recipient}.`,
                    );
                  })
                }
              >
                <Send size={15} />
                Send
              </button>
            )}
          {role !== "owner" && message.status === "draft" && (
            <small>The owner approves and sends it.</small>
          )}
        </div>
      )}
    </article>
  );
}
