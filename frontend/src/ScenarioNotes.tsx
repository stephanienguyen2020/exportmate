import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpRight,
  Bookmark,
  Check,
  Loader2,
  Sparkles,
  Trash2,
} from "lucide-react";
import { date } from "./data";
import {
  api,
  type SavedScenario,
  type ScenarioKind,
  type ScenarioPoint,
  type ScenarioSuggestion,
} from "./api";
import { errorMessage } from "./auth";
import "./scenario-notes.css";

// Saved what-ifs in the trade map's compare panel: an editor keeps a proposal (another
// market, ship date or route for one order) with a note, optionally started from an AI
// reading of the comparison. Saving changes nothing on the order.

function sameTarget(kind: ScenarioKind, a: string, b: string) {
  return kind === "ship_date" ? a === b : a.toUpperCase() === b.toUpperCase();
}

export default function ScenarioNotes({
  orderId,
  kind,
  target,
  ready,
  editable,
  onShow,
}: {
  orderId: string;
  kind: ScenarioKind;
  target: string | null;
  ready: boolean; // the comparison for `target` is on screen
  editable: boolean;
  onShow: (saved: SavedScenario) => void;
}) {
  const [saved, setSaved] = useState<SavedScenario[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) =>
      api
        .scenarios(orderId, signal)
        .then((rows) => {
          if (!signal?.aborted) {
            setSaved(rows);
            setLoadError("");
          }
        })
        .catch((e) => {
          if (!signal?.aborted) setLoadError(errorMessage(e));
        }),
    [orderId],
  );
  useEffect(() => {
    const controller = new AbortController();
    setSaved(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const current =
    target && saved
      ? saved.find((s) => s.kind === kind && sameTarget(kind, s.target, target))
      : undefined;

  async function remove(id: string) {
    try {
      await api.deleteScenario(id);
      setDeleting(null);
      await load();
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }

  return (
    <>
      {editable && target && ready && saved && (
        <ProposalForm
          key={`${orderId}|${kind}|${target}`}
          orderId={orderId}
          kind={kind}
          target={target}
          current={current}
          onSaved={() => void load()}
        />
      )}
      <section className="tm-section sn-saved" aria-label="Saved what-ifs">
        <h3>
          <Bookmark size={16} /> Saved what-ifs for {orderId}{" "}
          <span>{saved?.length ?? ""}</span>
        </h3>
        {loadError && (
          <p className="tm-muted" role="alert">
            {loadError}
          </p>
        )}
        {!saved && !loadError && <p className="tm-muted">Loading…</p>}
        {saved && !saved.length && (
          <p className="tm-muted">
            {editable
              ? "None yet. Compare a market, date or route, then save it with a note."
              : "None yet."}
          </p>
        )}
        <ul>
          {saved?.map((s) => {
            const open = s.id === current?.id;
            return (
              <li key={s.id} className={open ? "open" : ""}>
                <button
                  className="sn-label"
                  onClick={() => onShow(s)}
                  aria-current={open || undefined}
                >
                  {s.label} <ArrowUpRight size={13} />
                </button>
                {s.note && <p className="sn-note">{s.note}</p>}
                <small>
                  {counts(s)} · saved {date(s.updatedAt.slice(0, 10))}
                  {s.updatedBy ? ` by ${s.updatedBy.name}` : ""}
                </small>
                {editable &&
                  (deleting === s.id ? (
                    <span
                      className="sn-confirm"
                      role="group"
                      aria-label={`Delete ${s.label}`}
                    >
                      Delete this what-if?{" "}
                      <button
                        className="text-link"
                        onClick={() => void remove(s.id)}
                      >
                        Delete
                      </button>{" "}
                      <button
                        className="text-link"
                        onClick={() => setDeleting(null)}
                      >
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button
                      className="sn-delete"
                      aria-label={`Delete ${s.label}`}
                      onClick={() => setDeleting(s.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  ))}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

function counts(s: SavedScenario) {
  const c = s.comparison;
  const parts = [`${c.reevaluate.length} to re-evaluate`];
  if (c.unknown.length) parts.push(`${c.unknown.length} unknown`);
  return parts.join(", ");
}

function ProposalForm({
  orderId,
  kind,
  target,
  current,
  onSaved,
}: {
  orderId: string;
  kind: ScenarioKind;
  target: string;
  current: SavedScenario | undefined;
  onSaved: () => void;
}) {
  const [note, setNote] = useState(current?.note ?? "");
  const [busy, setBusy] = useState<"save" | "suggest" | null>(null);
  const [error, setError] = useState("");
  const [savedNow, setSavedNow] = useState(false);
  const [suggestion, setSuggestion] = useState<ScenarioSuggestion | null>(null);

  async function save() {
    setBusy("save");
    setError("");
    try {
      await api.saveScenario({
        orderId,
        kind,
        target,
        note: note.trim() || null,
      });
      setSavedNow(true);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function suggest() {
    setBusy("suggest");
    setError("");
    try {
      setSuggestion(await api.suggestScenarioNote({ orderId, kind, target }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="tm-section sn-form" aria-label="Save this what-if">
      <h3>
        <Bookmark size={16} /> {current ? "Saved what-if" : "Save this what-if"}
      </h3>
      <p className="tm-muted">
        Keeps this comparison on record with your note. Nothing on the order
        changes.
      </p>
      <label className="tm-field" htmlFor="sn-note">
        Note (optional)
      </label>
      <textarea
        id="sn-note"
        className="sn-textarea"
        maxLength={2000}
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          setSavedNow(false);
        }}
        placeholder="Why you're looking at this, who to ask, what would decide it"
      />
      {suggestion && (
        <div className="sn-suggestion" aria-label="AI suggestion">
          <span className="sn-eyebrow">
            <Sparkles size={13} /> AI SUGGESTION
          </span>
          <p>{suggestion.summary}</p>
          <Points title="Next steps" points={suggestion.nextSteps} />
          <Points
            title="To ask the buyer or supplier"
            points={suggestion.questions}
          />
          <div className="tm-form-actions">
            <button
              className="btn secondary"
              onClick={() => {
                setNote(suggestion.note);
                setSavedNow(false);
              }}
            >
              Use as note
            </button>
            {note.trim() && (
              <button
                className="text-link"
                onClick={() => {
                  setNote(`${note.trimEnd()}\n\n${suggestion.note}`);
                  setSavedNow(false);
                }}
              >
                Add below my note
              </button>
            )}
          </div>
          <p className="fine-print">
            Read from this comparison only. Check it before you save; it is not
            legal guidance.
          </p>
        </div>
      )}
      {error && (
        <p className="tm-field-error" role="alert">
          {error}
        </p>
      )}
      <div className="tm-form-actions">
        <button className="btn" disabled={!!busy} onClick={() => void save()}>
          {busy === "save" ? (
            <Loader2 size={15} className="spin" />
          ) : savedNow ? (
            <Check size={15} />
          ) : (
            <Bookmark size={15} />
          )}
          {savedNow ? "Saved" : current ? "Update" : "Save what-if"}
        </button>
        <button
          className="text-link sn-suggest"
          disabled={!!busy}
          onClick={() => void suggest()}
        >
          {busy === "suggest" ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <Sparkles size={14} />
          )}
          {suggestion ? "Suggest again" : "Suggest a note with AI"}
        </button>
      </div>
      {savedNow && (
        <p className="tm-muted" role="status">
          Saved. The order, its status and its documents are unchanged.
        </p>
      )}
    </section>
  );
}

function Points({ title, points }: { title: string; points: ScenarioPoint[] }) {
  if (!points.length) return null;
  return (
    <>
      <b className="sn-points-title">{title}</b>
      <ul className="sn-points">
        {points.map((p) => (
          <li key={p.text}>
            {p.text}
            <span className="sn-items">
              {p.items.map((item) => (
                <em key={item}>{item}</em>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
