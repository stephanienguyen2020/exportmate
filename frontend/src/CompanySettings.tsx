// Account page, signed-in companies: the cost settings analysis uses (owners edit them), the
// team (Team.tsx) and the activity log (owners only).
import { useEffect, useMemo, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { api, type AuditEvent, type CostSetting } from "./api";
import { errorMessage } from "./auth";
import Team from "./Team";
import "./analysis.css";

type Notify = (text: string, error?: boolean) => void;

const settingValue = (unit: string, value: number) =>
  unit === "days"
    ? `${value} ${value === 1 ? "day" : "days"}`
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: unit,
        maximumFractionDigits: 2,
      }).format(value / 100);
// What the input shows: days as typed, money in whole units.
const inputValue = (s: CostSetting) =>
  s.unit === "days" ? String(s.value) : String(s.value / 100);

export default function CompanySettings({
  role,
  notify,
}: {
  role: "owner" | "editor" | "viewer" | null;
  notify: Notify;
}) {
  return (
    <>
      <CostSettings owner={role === "owner"} notify={notify} />
      <Team role={role} notify={notify} />
      {role === "owner" && <ActivityLog />}
    </>
  );
}

function CostSettings({ owner, notify }: { owner: boolean; notify: Notify }) {
  const [settings, setSettings] = useState<CostSetting[] | null>(null);
  const [draft, setDraft] = useState<Record<string, { value: string; unit: string }>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const show = (next: CostSetting[]) => {
    setSettings(next);
    setDraft(
      Object.fromEntries(
        next.map((s) => [s.key, { value: inputValue(s), unit: s.unit }]),
      ),
    );
  };
  useEffect(() => {
    const controller = new AbortController();
    api
      .costSettings(controller.signal)
      .then((value) => !controller.signal.aborted && show(value))
      .catch((e) => !controller.signal.aborted && setError(errorMessage(e)));
    return () => controller.abort();
  }, []);
  const save = async (
    changes: { key: string; value: number | null; unit?: string }[],
    done: string,
  ) => {
    if (!changes.length || busy) return;
    setBusy(true);
    try {
      show(await api.updateCostSettings(changes));
      notify(done);
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  };
  const changes = () => {
    const out: { key: string; value: number; unit?: string }[] = [];
    for (const s of settings || []) {
      const d = draft[s.key];
      if (!d) continue;
      const number = Number(d.value.replace(/,/g, ""));
      if (!d.value.trim() || !Number.isFinite(number) || number < 0)
        throw new Error(`${s.label}: enter 0 or more.`);
      const value = s.unit === "days" ? Math.round(number) : Math.round(number * 100);
      const unit = d.unit.trim().toUpperCase();
      if (s.unit !== "days" && !/^[A-Z]{3}$/.test(unit))
        throw new Error(`${s.label}: a currency code such as USD.`);
      if (value !== s.value || (s.unit !== "days" && unit !== s.unit))
        out.push(s.unit === "days" ? { key: s.key, value } : { key: s.key, value, unit });
    }
    return out;
  };
  return (
    <section className="panel co-panel" aria-label="Cost settings">
      <span className="eyebrow">COST SETTINGS</span>
      <h2>What a problem costs you.</h2>
      <p>
        Analysis prices missing documents, new tests and delays with these
        values. {owner ? "Change them to match your business." : "Only the company owner can change them."}
      </p>
      {error ? (
        <p role="alert">{error}</p>
      ) : !settings ? (
        <p role="status">
          <Loader2 size={15} className="spin" /> Loading…
        </p>
      ) : (
        <form
          className="co-form"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              void save(changes(), "Cost settings saved.");
            } catch (err) {
              notify((err as Error).message, true);
            }
          }}
        >
          <div className="table-scroll">
            <table className="co-table">
              <thead>
                <tr>
                  <th>Setting</th>
                  <th>Default</th>
                  <th>Your value</th>
                  {owner && (
                    <th>
                      <span className="sr-only">Reset</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {settings.map((s) => (
                  <tr key={s.key}>
                    <td>{s.label}</td>
                    <td className="mono">
                      {settingValue(s.defaultUnit, s.defaultValue)}
                    </td>
                    <td>
                      {owner ? (
                        <span className="pb-money">
                          <input
                            aria-label={`${s.label}: your value`}
                            inputMode="decimal"
                            value={draft[s.key]?.value ?? ""}
                            onChange={(e) =>
                              setDraft((all) => ({
                                ...all,
                                [s.key]: { ...all[s.key], value: e.target.value },
                              }))
                            }
                          />
                          {s.unit === "days" ? (
                            <span>days</span>
                          ) : (
                            <input
                              aria-label={`${s.label}: currency`}
                              maxLength={3}
                              value={draft[s.key]?.unit ?? ""}
                              onChange={(e) =>
                                setDraft((all) => ({
                                  ...all,
                                  [s.key]: {
                                    ...all[s.key],
                                    unit: e.target.value.toUpperCase(),
                                  },
                                }))
                              }
                            />
                          )}
                        </span>
                      ) : (
                        <span className="mono">{settingValue(s.unit, s.value)}</span>
                      )}
                      <small>
                        {s.source === "company_setting" ? "Your company's value" : "Default"}
                      </small>
                    </td>
                    {owner && (
                      <td>
                        {s.source === "company_setting" && (
                          <button
                            type="button"
                            className="text-link"
                            disabled={busy}
                            onClick={() =>
                              void save(
                                [{ key: s.key, value: null }],
                                `${s.label} is back to the default.`,
                              )
                            }
                          >
                            <RotateCcw size={13} />
                            Reset to default
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {owner && (
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save cost settings"}
            </button>
          )}
        </form>
      )}
    </section>
  );
}

const OBJECT_TYPES: [string, string][] = [
  ["", "Everything"],
  ["import", "Imports"],
  ["order", "Orders"],
  ["analysis_run", "Analysis runs"],
  ["analysis_report", "Analysis reports"],
  ["hs_code_suggestion", "HS code suggestions"],
  ["supplier_message", "Supplier messages"],
  ["report", "Shared reports"],
  ["supplier", "Suppliers"],
  ["supplier_document_upload", "Supplier certificates"],
  ["company_site", "Sites"],
  ["playbook_rule", "Playbook rules"],
  ["regulation_document", "Regulation documents"],
  ["market_requirement", "Market requirements"],
  ["company", "Company"],
  ["member", "Team members"],
  ["invite", "Invitations"],
];

function ActivityLog() {
  const [objectType, setObjectType] = useState("");
  const [userId, setUserId] = useState("");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // People seen so far, so the filter keeps them after it narrows the list.
  const [people, setPeople] = useState<Map<string, string>>(new Map());
  const load = async (next: string | null, signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const page = await api.auditEvents(
        { objectType, userId, cursor: next },
        signal,
      );
      if (signal?.aborted) return;
      setEvents((all) => (next ? [...all, ...page.events] : page.events));
      setCursor(page.nextCursor);
      setPeople((known) => {
        const map = new Map(known);
        for (const e of page.events) if (e.user) map.set(e.user.id, e.user.name || e.user.email);
        return map;
      });
    } catch (e) {
      if (!signal?.aborted) setError(errorMessage(e));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void load(null, controller.signal);
    return () => controller.abort();
  }, [objectType, userId]);
  const personOptions = useMemo(() => [...people.entries()], [people]);
  return (
    <section className="panel co-panel" aria-label="Activity log">
      <span className="eyebrow">ACTIVITY LOG · OWNER ONLY</span>
      <h2>Who did what, and when.</h2>
      <p>Imports, edits, approvals and sent messages in your company, newest first.</p>
      <div className="co-filters">
        <label>
          Show
          <select value={objectType} onChange={(e) => setObjectType(e.target.value)}>
            {OBJECT_TYPES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Person
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Everyone</option>
            {personOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {events.length ? (
        <ul className="co-events">
          {events.map((e) => (
            <li key={e.id}>
              <span>
                {new Date(e.createdAt).toLocaleString("en-GB", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                <small>{e.user ? e.user.name || e.user.email : "System"}</small>
              </span>
              <div>
                <b>{e.action}</b>
                <small>
                  {e.objectType} · {e.objectId}
                  {Object.keys(e.data).length > 0 &&
                    ` · ${Object.entries(e.data)
                      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                      .join(", ")}`}
                </small>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        !loading && !error && <p>Nothing recorded yet.</p>
      )}
      {loading && (
        <p role="status">
          <Loader2 size={15} className="spin" /> Loading…
        </p>
      )}
      {cursor && !loading && (
        <button className="btn secondary" onClick={() => void load(cursor)}>
          Load more
        </button>
      )}
    </section>
  );
}
