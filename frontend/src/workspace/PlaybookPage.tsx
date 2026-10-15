import { useEffect, useState } from "react";
import { ArrowUpRight, Check, Plus, Settings2, Trash2 } from "lucide-react";
import {
  RuleBuilder,
  RuleConditionsEditor,
  describeRule,
  emptyRuleDraft,
  ruleBody,
} from "../Playbook";
import type { Workspace } from "./store";
import { Button, PageHeading, type Notify } from "./ui";

export default function PlaybookPage({
  ws,
  notify,
}: {
  ws: Workspace;
  notify: Notify;
}) {
  const { live, editable, busy, rules, ruleFields } = ws;
  const currency = ws.account?.company?.currency || "USD";
  const [ruleText, setRuleText] = useState("");
  const [category, setCategory] = useState("Policy");
  const [newRule, setNewRule] = useState(emptyRuleDraft);
  // First click on a rule's delete button asks for a second click to confirm.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(null), 5000);
    return () => clearTimeout(t);
  }, [confirmDelete]);
  useEffect(() => {
    const controller = new AbortController();
    ws.loadRuleFields(controller.signal);
    return () => controller.abort();
  }, []);
  function addRule() {
    if (!ruleText.trim()) return;
    let checks;
    try {
      checks = ruleFields
        ? ruleBody(newRule, ruleFields)
        : { when: null, then: null };
    } catch (error) {
      notify((error as Error).message, true);
      return;
    }
    void ws.mutate(async () => {
      const rule = await ws.addRule({
        text: ruleText.trim(),
        category,
        ...checks,
      });
      setRuleText("");
      setNewRule(emptyRuleDraft());
      notify(
        !live
          ? "Rule added to your local playbook."
          : rule.checked
            ? "Rule saved. Analysis checks it on every order."
            : "Rule saved to your playbook.",
      );
    });
  }
  return (
    <>
      <PageHeading
        label="YOUR EXPERIENCE. WRITTEN INTO THE PROCESS."
        title="Your playbook."
        description="Set thresholds and trading policies."
      />
      <div className="notice">
        <Settings2 size={18} />
        {live
          ? "Rules are saved to your company playbook. The ExportMate assistant follows the ones switched on when it advises you. Analysis also checks every switched-on rule with conditions against each order."
          : "Rules are saved in this browser. The ExportMate assistant follows the ones switched on when it advises you."}
      </div>
      <div className="playbook-grid">
        <section>
          <div className="section-heading">
            <h2>The rules you trade by.</h2>
            <span className="eyebrow">
              {rules.filter((r) => r.enabled).length} ACTIVE
            </span>
          </div>
          {rules.map((r) => (
            <div
              className={"playbook-rule " + (!r.enabled ? "disabled-rule" : "")}
              key={r.id}
            >
              <div>
                <span className="eyebrow">
                  {r.category}
                  {live && (
                    <span className={"pb-badge" + (r.checked ? "" : " off")}>
                      {r.checked ? "CHECKED" : "NOT CHECKED"}
                    </span>
                  )}
                </span>
                <p>{r.text}</p>
                {live && r.checked && (
                  <p className="pb-conditions">{describeRule(r, ruleFields)}</p>
                )}
                {live && editable && ruleFields && (
                  <RuleConditionsEditor
                    rule={r}
                    fields={ruleFields}
                    currency={currency}
                    busy={busy}
                    onSave={async (body) => {
                      let saved = false;
                      await ws.mutate(async () => {
                        const updated = await ws.updateRule(r.id, body);
                        notify(
                          updated.checked
                            ? "Conditions saved. Analysis checks this rule from now on."
                            : "Conditions removed. The rule is stored only.",
                        );
                        saved = true;
                      });
                      return saved;
                    }}
                  />
                )}
              </div>
              <button
                className={"toggle " + (r.enabled ? "on" : "")}
                role="switch"
                aria-checked={r.enabled}
                aria-label={`Enable rule: ${r.text}`}
                disabled={busy || !editable}
                onClick={() => void ws.mutate(() => ws.toggleRule(r))}
              >
                <span />
              </button>
              <button
                className={
                  "icon-btn" + (confirmDelete === r.id ? " confirm-delete" : "")
                }
                aria-label={
                  confirmDelete === r.id
                    ? `Confirm delete rule: ${r.text}`
                    : `Delete rule: ${r.text}`
                }
                disabled={busy || !editable}
                onClick={() => {
                  if (confirmDelete !== r.id) {
                    setConfirmDelete(r.id);
                    return;
                  }
                  setConfirmDelete(null);
                  void ws.mutate(async () => {
                    await ws.deleteRule(r.id);
                    notify("Rule deleted.");
                  });
                }}
              >
                {confirmDelete === r.id ? (
                  <>
                    <Check size={15} />
                    <span>Delete?</span>
                  </>
                ) : (
                  <Trash2 size={16} />
                )}
              </button>
            </div>
          ))}
          {!rules.length && (
            <div className="empty">
              Your playbook is a clean slate. Add your first rule.
            </div>
          )}
        </section>
        <form
          className="panel add-rule"
          onSubmit={(e) => {
            e.preventDefault();
            addRule();
          }}
        >
          <Plus size={25} />
          <h3>Add a rule.</h3>
          <label htmlFor="category">Type of rule</label>
          <select
            id="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {["Policy", "Threshold", "Supplier", "Watchlist"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <label htmlFor="rule-text">In your own words</label>
          <textarea
            id="rule-text"
            required
            maxLength={500}
            value={ruleText}
            onChange={(e) => setRuleText(e.target.value)}
            placeholder="For example: Tell me if an order’s margin falls below 8%."
          />
          {live && ruleFields && (
            <RuleBuilder
              idPrefix="new-rule"
              fields={ruleFields}
              draft={newRule}
              currency={currency}
              disabled={busy || !editable}
              onChange={setNewRule}
            />
          )}
          <Button type="submit" disabled={busy || !editable || !ruleText.trim()}>
            Add to my playbook
            <ArrowUpRight size={17} />
          </Button>
        </form>
      </div>
    </>
  );
}
