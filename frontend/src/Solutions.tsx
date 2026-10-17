// Suggested solutions on an order's analysis report: for each missing or wrong document, the
// company's saved solution to the same problem (written by AI or a person, with its people's
// notes), a button to ask AI for one and a box to write one yourself. Expired solutions are
// listed for reference, never as the answer: they can't be used or adopted, only analysed
// again. Every change is in the activity log.
import { useEffect, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  History,
  Loader2,
  MessageSquarePlus,
  PenLine,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import {
  api,
  type AnalysisReport,
  type Solution,
  type SolutionCase,
} from "./api";
import { errorMessage } from "./auth";
import { RegulationCitation } from "./Regulations";
import "./solutions.css";

type Role = "owner" | "editor" | "viewer" | null;
type Notify = (text: string, error?: boolean) => void;

const day = (iso: string) =>
  new Date(iso + (iso.length === 10 ? "T00:00:00" : "")).toLocaleDateString(
    "en-GB",
    { day: "numeric", month: "short", year: "numeric" },
  );

const STATUS_LABEL: Record<Solution["status"], string> = {
  suggested: "AI suggestion",
  adopted: "Adopted",
  rejected: "Rejected",
};
// A solution with no model was written by a person.
const statusLabel = (solution: Solution) =>
  solution.expired
    ? "Expired"
    : solution.status === "suggested" && !solution.model
      ? "Team suggestion"
      : STATUS_LABEL[solution.status];

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

export default function Solutions({
  report,
  role,
  notify,
}: {
  report: AnalysisReport;
  role: Role;
  notify: Notify;
}) {
  const editable = role === "owner" || role === "editor";
  const [cases, setCases] = useState<SolutionCase[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setCases(null);
    setError("");
    const controller = new AbortController();
    api
      .reportSolutions(report.id, controller.signal)
      .then((value) => !controller.signal.aborted && setCases(value))
      .catch((e) => !controller.signal.aborted && setError(errorMessage(e)));
    return () => controller.abort();
  }, [report.id]);
  const replaceCase = (next: SolutionCase) =>
    setCases((all) =>
      (all || []).map((c) =>
        c.requirementKey === next.requirementKey ? next : c,
      ),
    );
  // A note changes one solution, wherever it is listed.
  const replaceSolution = (next: Solution) =>
    setCases((all) =>
      (all || []).map((c) => {
        const swap = (s: Solution) => (s.id === next.id ? next : s);
        return {
          ...c,
          default: c.default && swap(c.default),
          others: c.others.map(swap),
          expired: c.expired.map(swap),
        };
      }),
    );
  // Adopting or rejecting one changes which solution is the default.
  const reload = async () => setCases(await api.reportSolutions(report.id));
  if (!error && cases && cases.length === 0) return null;
  return (
    <section className="panel an-solutions" aria-label="Suggested solutions">
      <div className="an-report-head">
        <div>
          <span className="eyebrow">HOW TO SOLVE IT</span>
          <h2>Suggested solutions.</h2>
        </div>
        <a className="text-link" href="#/workspace/knowledge">
          All saved solutions
        </a>
      </div>
      <p>
        AI suggests steps for each problem from the cited text and your team's
        notes, or you write your own. Solutions are saved and offered for later
        orders with the same problem until they expire. An expired one is shown for reference only:
        analyse it again before relying on it.
      </p>
      {error && <p role="alert">{error}</p>}
      {!cases && !error && (
        <p role="status">
          <Loader2 size={15} className="spin" /> Loading…
        </p>
      )}
      {(cases || []).map((item) => (
        <SolutionCaseView
          key={item.requirementKey}
          item={item}
          reportId={report.id}
          orderId={report.order.id}
          editable={editable}
          notify={notify}
          onCase={replaceCase}
          onSolution={replaceSolution}
          onReviewed={reload}
        />
      ))}
    </section>
  );
}

function SolutionCaseView({
  item,
  reportId,
  orderId,
  editable,
  notify,
  onCase,
  onSolution,
  onReviewed,
}: {
  item: SolutionCase;
  reportId: string;
  orderId: string;
  editable: boolean;
  notify: Notify;
  onCase: (next: SolutionCase) => void;
  onSolution: (next: Solution) => void;
  onReviewed: () => Promise<void>;
}) {
  const { busy, act } = useAction(notify);
  const [writing, setWriting] = useState(false);
  const suggest = () =>
    act("suggest", async () => {
      onCase(await api.suggestSolution(reportId, item.requirementKey));
      notify("AI suggested a solution. It's saved for later orders too.");
    });
  const write = (summary: string, steps: string[]) =>
    act("write", async () => {
      onCase(
        await api.writeSolution(reportId, item.requirementKey, summary, steps),
      );
      setWriting(false);
      notify("Your solution is saved for later orders too, under your name.");
    });
  const card = (solution: Solution, isDefault: boolean) => (
    <SolutionCard
      key={solution.id}
      solution={solution}
      isDefault={isDefault}
      inUse={isDefault && item.inUse}
      orderId={orderId}
      editable={editable}
      notify={notify}
      onUse={() =>
        act("use", async () => {
          onCase(await api.useSolution(solution.id, reportId));
          notify(`Recorded: ${orderId} follows this solution.`);
        })
      }
      onSolution={onSolution}
      onReviewed={onReviewed}
      busy={!!busy}
    />
  );
  return (
    <article className="sol-case" aria-label={item.title}>
      <h3>
        {item.title}
        <small>{item.problemStatus === "missing" ? "Missing" : "Wrong"}</small>
      </h3>
      <p>{item.note}</p>
      {item.default ? (
        card(item.default, true)
      ) : (
        <p className="an-callout">
          <CircleAlert size={15} />
          {item.expired.length
            ? "The saved solutions for this problem expired. Analyse it again before acting on one."
            : "No saved solution for this problem yet."}
        </p>
      )}
      {editable && (
        <div className="an-actions">
          <button
            className={item.default ? "btn secondary" : "btn"}
            disabled={!!busy}
            onClick={suggest}
          >
            {busy === "suggest" ? (
              <Loader2 size={15} className="spin" />
            ) : item.expired.length && !item.default ? (
              <RefreshCw size={15} />
            ) : (
              <Sparkles size={15} />
            )}
            {item.default
              ? "Ask AI for another"
              : item.expired.length
                ? "Analyse again"
                : "Suggest a solution"}
          </button>
          {!writing && (
            <button
              className="btn secondary"
              disabled={!!busy}
              onClick={() => setWriting(true)}
            >
              <PenLine size={15} />
              Write your own
            </button>
          )}
        </div>
      )}
      {editable && writing && (
        <WriteSolution
          id={`sol-write-${item.requirementKey}`}
          busy={busy === "write"}
          onSave={write}
          onCancel={() => setWriting(false)}
        />
      )}
      {item.others.length > 0 && (
        <details className="an-details">
          <summary>Other saved solutions ({item.others.length})</summary>
          {item.others.map((s) => card(s, false))}
        </details>
      )}
      {item.expired.length > 0 && (
        <details className="an-details">
          <summary>
            <History size={13} /> Expired solutions ({item.expired.length}),
            for reference only
          </summary>
          {item.expired.map((s) => card(s, false))}
        </details>
      )}
    </article>
  );
}

// A person's own solution to one problem: saved like an AI one, without AI or its checks.
function WriteSolution({
  id,
  busy,
  onSave,
  onCancel,
}: {
  id: string;
  busy: boolean;
  onSave: (summary: string, steps: string[]) => void;
  onCancel: () => void;
}) {
  const [summary, setSummary] = useState("");
  const [steps, setSteps] = useState("");
  return (
    <form
      className="sol-write"
      aria-label="Write your own solution"
      onSubmit={(e) => {
        e.preventDefault();
        if (!summary.trim()) return;
        onSave(
          summary.trim(),
          steps
            .split("\n")
            .map((step) => step.trim())
            .filter(Boolean),
        );
      }}
    >
      <label htmlFor={id + "-summary"}>What to do</label>
      <textarea
        id={id + "-summary"}
        rows={2}
        value={summary}
        placeholder="E.g. Ask the supplier for the certificate before booking the shipment."
        onChange={(e) => setSummary(e.target.value)}
      />
      <label htmlFor={id + "-steps"}>Steps, one per line (optional)</label>
      <textarea
        id={id + "-steps"}
        rows={4}
        value={steps}
        onChange={(e) => setSteps(e.target.value)}
      />
      <p className="fine-print">
        Saved under your name without AI or its checks, and offered for later
        orders with the same problem. It's in the activity log.
      </p>
      <div className="an-actions">
        <button
          className="btn"
          type="submit"
          disabled={busy || !summary.trim()}
        >
          {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
          Save solution
        </button>
        <button
          className="btn secondary"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// Also listed in the knowledge base (KnowledgeBase.tsx), where there is no order to use it for.
export function SolutionCard({
  solution,
  isDefault,
  inUse,
  orderId,
  editable,
  busy,
  notify,
  onUse,
  onSolution,
  onReviewed,
}: {
  solution: Solution;
  isDefault: boolean;
  inUse: boolean;
  orderId?: string;
  editable: boolean;
  busy: boolean;
  notify: Notify;
  onUse?: () => void;
  onSolution: (next: Solution) => void;
  onReviewed: () => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const { busy: saving, act } = useAction(notify);
  const id = `sol-${solution.id}`;
  const usable = !solution.expired && solution.status !== "rejected";
  const review = (verdict: "adopted" | "rejected") =>
    act(verdict, async () => {
      await api.reviewSolution(solution.id, verdict, null);
      await onReviewed();
      notify(
        verdict === "adopted"
          ? "Adopted: offered first for this problem from now on."
          : "Rejected: it won't be offered as the answer.",
      );
    });
  return (
    <div
      className={
        "sol-card" +
        (solution.expired ? " expired" : "") +
        (isDefault ? " default" : "")
      }
    >
      <div className="an-meta">
        <span
          className={`status ${solution.expired || solution.status === "rejected" ? "red" : solution.status === "adopted" ? "green" : "amber"}`}
        >
          <i />
          {statusLabel(solution)}
        </span>
        {inUse && orderId && (
          <span className="status green">
            <i />
            Used for {orderId}
          </span>
        )}
        <span>
          Written for {solution.writtenFor || "an earlier order"} ·{" "}
          {day(solution.createdAt)} ·{" "}
          {solution.model ? "asked by" : "written by"} {solution.createdBy.name}
          {solution.reviewedBy &&
            ` · ${solution.status} by ${solution.reviewedBy.name}`}
          {solution.usedFor > 0 &&
            ` · used for ${solution.usedFor} order${solution.usedFor === 1 ? "" : "s"}`}
        </span>
      </div>
      {solution.expired ? (
        <p className="an-callout sol-expired">
          <History size={15} /> Not for use: {solution.expiredReason}
        </p>
      ) : (
        <p className="fine-print">Valid until {day(solution.validUntil)}.</p>
      )}
      <p className="sol-summary">{solution.summary}</p>
      <ol className="an-list">
        {solution.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <RegulationCitation
        source={{
          regulationId: "",
          regulationTitle: solution.basis.regulationTitle,
          documentTitle: solution.basis.regulationTitle,
          officialId: null,
          documentId: solution.basis.documentId,
          versionNumber: solution.basis.versionNumber,
          sourceUrl: solution.basis.sourceUrl,
          quote: solution.basis.quote,
        }}
      />
      <div className="sol-notes" aria-label="Notes from your team">
        <strong>How your team handles it</strong>
        {solution.notes.length === 0 && (
          <p className="fine-print">No notes yet.</p>
        )}
        {solution.notes.map((n) => (
          <blockquote key={n.id}>
            {n.text}
            <small>
              {n.author.name} · {day(n.createdAt)}
            </small>
          </blockquote>
        ))}
        {editable && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const text = note.trim();
              if (!text) return;
              void act("note", async () => {
                onSolution(await api.addSolutionNote(solution.id, text));
                setNote("");
                notify("Note saved. The AI reads it next time.");
              });
            }}
          >
            <label htmlFor={id + "-note"}>
              Add how you handle it (kept for good, read by the AI next time)
            </label>
            <textarea
              id={id + "-note"}
              rows={2}
              maxLength={2000}
              value={note}
              placeholder="E.g. we ask for the GeoJSON file, not a screenshot."
              onChange={(e) => setNote(e.target.value)}
            />
            <button
              className="btn secondary"
              type="submit"
              disabled={!!saving || !note.trim()}
            >
              <MessageSquarePlus size={15} />
              Add note
            </button>
          </form>
        )}
      </div>
      {editable && usable && (
        <div className="an-actions">
          {!inUse && orderId && onUse && (
            <button className="btn" disabled={busy || !!saving} onClick={onUse}>
              <Check size={15} />
              Use for {orderId}
            </button>
          )}
          {solution.status !== "adopted" && (
            <button
              className="btn secondary"
              disabled={busy || !!saving}
              onClick={() => review("adopted")}
            >
              Adopt for this problem
            </button>
          )}
          <button
            className="btn secondary"
            disabled={busy || !!saving}
            onClick={() => review("rejected")}
          >
            <X size={15} />
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
