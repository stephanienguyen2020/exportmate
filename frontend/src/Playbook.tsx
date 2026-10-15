// Checked playbook rules: WHEN every condition holds THEN an action. The fields, comparisons
// and actions come from GET /playbook/fields, so a new field needs no frontend change.
import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { RuleAction, RuleCondition, RuleFields } from "./api";
import "./analysis.css";

type Field = RuleFields["fields"][number];
// What the form holds: values as typed. Money is in whole units with its own currency.
export type ConditionDraft = {
  field: string;
  op: string;
  value: string;
  currency: string;
};
export type RuleDraft = {
  checked: boolean;
  when: ConditionDraft[];
  action: string;
  note: string;
};

const firstOp = (field?: Field) => Object.keys(field?.ops || {})[0] || "";
const blankCondition = (fields: RuleFields, currency: string): ConditionDraft => {
  const field = fields.fields[0];
  return {
    field: field?.key || "",
    op: firstOp(field),
    value: field?.options?.[0]?.value || "",
    currency,
  };
};

export function emptyRuleDraft(): RuleDraft {
  return { checked: false, when: [], action: "", note: "" };
}

/** The form's state for a stored rule. */
export function ruleDraft(
  rule: { when?: RuleCondition[] | null; then?: RuleAction | null },
  currency: string,
): RuleDraft {
  if (!rule.when?.length || !rule.then) return emptyRuleDraft();
  return {
    checked: true,
    when: rule.when.map((c) => {
      const money =
        c.value && typeof c.value === "object"
          ? (c.value as { amountMinor: number; currency: string })
          : null;
      return {
        field: c.field,
        op: c.op,
        value: money
          ? String(money.amountMinor / 100)
          : c.value == null
            ? ""
            : String(c.value),
        currency: money?.currency || currency,
      };
    }),
    action: rule.then.action,
    note: rule.then.note || "",
  };
}

/** The request body's `when` and `then`, both null for a rule that's stored only.
 *  Throws a readable error for a value that can't be sent. */
export function ruleBody(
  draft: RuleDraft,
  fields: RuleFields,
): { when: RuleCondition[] | null; then: RuleAction | null } {
  if (!draft.checked) return { when: null, then: null };
  if (!draft.when.length) throw new Error("Add at least one condition.");
  if (!draft.action) throw new Error("Choose what happens when the rule applies.");
  const when = draft.when.map((c, i) => {
    const field = fields.fields.find((f) => f.key === c.field);
    const where = `Condition ${i + 1}`;
    if (!field) throw new Error(`${where}: choose a field.`);
    if (fields.noValueOps.includes(c.op))
      return { field: c.field, op: c.op, value: null };
    const text = c.value.trim();
    if (!text) throw new Error(`${where}: add a value.`);
    if (field.type === "number") {
      if (!/^-?\d+$/.test(text)) throw new Error(`${where}: a whole number.`);
      return { field: c.field, op: c.op, value: Number(text) };
    }
    if (field.type === "money") {
      const amount = Number(text.replace(/,/g, ""));
      if (!Number.isFinite(amount) || amount < 0)
        throw new Error(`${where}: an amount, 0 or more.`);
      if (!/^[A-Za-z]{3}$/.test(c.currency.trim()))
        throw new Error(`${where}: a currency code such as USD.`);
      return {
        field: c.field,
        op: c.op,
        value: {
          amountMinor: Math.round(amount * 100),
          currency: c.currency.trim().toUpperCase(),
        },
      };
    }
    return { field: c.field, op: c.op, value: text };
  });
  return { when, then: { action: draft.action, note: draft.note.trim() || null } };
}

/** "Market is EU and Days until ship date less than 21 → Owner review". */
export function describeRule(
  rule: { when?: RuleCondition[] | null; then?: RuleAction | null },
  fields: RuleFields | null,
): string {
  if (!rule.when?.length || !rule.then) return "";
  const conditions = rule.when.map((c) => {
    const field = fields?.fields.find((f) => f.key === c.field);
    const op = field?.ops[c.op] || c.op;
    const money =
      c.value && typeof c.value === "object"
        ? (c.value as { amountMinor: number; currency: string })
        : null;
    const value = money
      ? `${money.currency} ${(money.amountMinor / 100).toLocaleString("en-US", {
          minimumFractionDigits: money.amountMinor % 100 ? 2 : 0,
        })}`
      : c.value == null
        ? ""
        : field?.options?.find((o) => o.value === c.value)?.label ||
          String(c.value);
    return [field?.label || c.field, op, value].filter(Boolean).join(" ");
  });
  const action = fields?.actions[rule.then.action] || rule.then.action;
  return `When ${conditions.join(" and ")} → ${action}${rule.then.note ? ` (“${rule.then.note}”)` : ""}`;
}

export function RuleBuilder({
  idPrefix,
  fields,
  draft,
  currency,
  disabled,
  onChange,
}: {
  idPrefix: string;
  fields: RuleFields;
  draft: RuleDraft;
  currency: string;
  disabled?: boolean;
  onChange: (draft: RuleDraft) => void;
}) {
  const setCondition = (i: number, change: Partial<ConditionDraft>) =>
    onChange({
      ...draft,
      when: draft.when.map((c, j) => (j === i ? { ...c, ...change } : c)),
    });
  return (
    <fieldset className="pb-builder" disabled={disabled}>
      <legend>Check it on every analysis</legend>
      <label className="an-check">
        <input
          type="checkbox"
          checked={draft.checked}
          onChange={(e) =>
            onChange(
              e.target.checked
                ? {
                    ...draft,
                    checked: true,
                    when: draft.when.length
                      ? draft.when
                      : [blankCondition(fields, currency)],
                    action: draft.action || Object.keys(fields.actions)[0] || "",
                  }
                : { ...draft, checked: false },
            )
          }
        />
        Add conditions, so analysis applies this rule to orders
      </label>
      {draft.checked && (
        <>
          <b className="eyebrow">WHEN</b>
          {draft.when.map((c, i) => {
            const field = fields.fields.find((f) => f.key === c.field);
            const id = `${idPrefix}-c${i}`;
            return (
              <div className="pb-row" key={i}>
                <select
                  aria-label={`Condition ${i + 1}: field`}
                  value={c.field}
                  onChange={(e) => {
                    const next = fields.fields.find(
                      (f) => f.key === e.target.value,
                    );
                    setCondition(i, {
                      field: e.target.value,
                      op: firstOp(next),
                      value: next?.options?.[0]?.value || "",
                    });
                  }}
                >
                  {fields.fields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Condition ${i + 1}: comparison`}
                  value={c.op}
                  onChange={(e) => setCondition(i, { op: e.target.value })}
                >
                  {Object.entries(field?.ops || {}).map(([op, label]) => (
                    <option key={op} value={op}>
                      {label}
                    </option>
                  ))}
                </select>
                {fields.noValueOps.includes(c.op) ? (
                  <span />
                ) : field?.options ? (
                  <select
                    aria-label={`Condition ${i + 1}: value`}
                    value={c.value}
                    onChange={(e) => setCondition(i, { value: e.target.value })}
                  >
                    {field.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : field?.type === "money" ? (
                  <span className="pb-money">
                    <input
                      id={id}
                      aria-label={`Condition ${i + 1}: amount`}
                      inputMode="decimal"
                      value={c.value}
                      placeholder="2000"
                      onChange={(e) =>
                        setCondition(i, { value: e.target.value })
                      }
                    />
                    <input
                      aria-label={`Condition ${i + 1}: currency`}
                      maxLength={3}
                      value={c.currency}
                      onChange={(e) =>
                        setCondition(i, {
                          currency: e.target.value.toUpperCase(),
                        })
                      }
                    />
                  </span>
                ) : (
                  <input
                    id={id}
                    aria-label={`Condition ${i + 1}: value`}
                    inputMode={field?.type === "number" ? "numeric" : undefined}
                    value={c.value}
                    placeholder={
                      field?.type === "hs_code"
                        ? "9403"
                        : field?.type === "number"
                          ? "21"
                          : ""
                    }
                    onChange={(e) => setCondition(i, { value: e.target.value })}
                  />
                )}
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove condition ${i + 1}`}
                  disabled={draft.when.length === 1}
                  onClick={() =>
                    onChange({
                      ...draft,
                      when: draft.when.filter((_, j) => j !== i),
                    })
                  }
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
          {draft.when.length < 10 && (
            <button
              type="button"
              className="text-link"
              onClick={() =>
                onChange({
                  ...draft,
                  when: [...draft.when, blankCondition(fields, currency)],
                })
              }
            >
              <Plus size={13} />
              And another condition
            </button>
          )}
          <b className="eyebrow">THEN</b>
          <select
            aria-label="Then"
            value={draft.action}
            onChange={(e) => onChange({ ...draft, action: e.target.value })}
          >
            {Object.entries(fields.actions).map(([action, label]) => (
              <option key={action} value={action}>
                {label}
              </option>
            ))}
          </select>
          <input
            aria-label="Note on the report (optional)"
            maxLength={500}
            placeholder="Note on the report, e.g. Move the ship date (optional)"
            value={draft.note}
            onChange={(e) => onChange({ ...draft, note: e.target.value })}
          />
        </>
      )}
    </fieldset>
  );
}

/** A stored rule's conditions, edited in place. */
export function RuleConditionsEditor({
  rule,
  fields,
  currency,
  busy,
  onSave,
}: {
  rule: { id: string; when?: RuleCondition[] | null; then?: RuleAction | null };
  fields: RuleFields;
  currency: string;
  busy: boolean;
  onSave: (body: {
    when: RuleCondition[] | null;
    then: RuleAction | null;
  }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => ruleDraft(rule, currency));
  const [error, setError] = useState("");
  if (!open)
    return (
      <button
        type="button"
        className="text-link pb-edit"
        onClick={() => {
          setDraft(ruleDraft(rule, currency));
          setError("");
          setOpen(true);
        }}
      >
        {rule.when?.length ? "Edit conditions" : "Add conditions"}
      </button>
    );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        let body;
        try {
          body = ruleBody(draft, fields);
        } catch (err) {
          setError((err as Error).message);
          return;
        }
        if (await onSave(body)) setOpen(false);
      }}
    >
      <RuleBuilder
        idPrefix={`rule-${rule.id}`}
        fields={fields}
        draft={draft}
        currency={currency}
        disabled={busy}
        onChange={setDraft}
      />
      {error && (
        <p className="an-error" role="alert">
          {error}
        </p>
      )}
      <div className="an-actions">
        <button className="btn secondary" type="submit" disabled={busy}>
          Save conditions
        </button>
        <button
          type="button"
          className="text-link"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
