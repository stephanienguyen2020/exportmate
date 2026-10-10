import React from "react";
import {
  Bell,
  Brain,
  Calculator,
  CircleAlert,
  CircleCheck,
  Database,
  Download,
  FilePen,
  Radar,
  Search,
  ShieldCheck,
} from "lucide-react";
import { downloadJson, type Audit, type AuditStep } from "./agent-client";

const TOOL_LABELS: Record<string, [React.ElementType, string]> = {
  search_knowledge: [Search, "Searched the vector index"],
  query_inventory: [Database, "Queried stock in Firestore"],
  get_alerts: [Bell, "Read news alerts"],
  calculate: [Calculator, "Calculated"],
  get_scan_status: [Radar, "Checked news scan status"],
};

const seconds = (ms = 0) => `${(ms / 1000).toFixed(1)}s`;
const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

/** One-line description of a step, used for live progress and the timeline. */
export function describeStep(step: AuditStep): { icon: React.ElementType; label: string; detail?: string } {
  if (step.kind === "plan")
    return {
      icon: Brain,
      label: "Planned next step",
      detail: step.calls?.map((c) => c.name).join(", "),
    };
  if (step.kind === "tool") {
    const [icon, label] = TOOL_LABELS[step.name || ""] || [Search, step.name || "Tool"];
    if (step.error) return { icon, label, detail: `failed: ${step.error}` };
    if (step.name === "calculate") return { icon, label, detail: `${step.expression} = ${step.result}` };
    const query = typeof step.args?.query === "string" ? `“${step.args.query}” · ` : "";
    return { icon, label, detail: `${query}${step.count ?? 0} result${step.count === 1 ? "" : "s"}` };
  }
  if (step.kind === "draft") return { icon: FilePen, label: "Drafted an answer" };
  if (step.kind === "review") return { icon: ShieldCheck, label: "Auditor sent the draft back", detail: step.problems?.join(" ") };
  return { icon: FilePen, label: "Wrote the final answer" };
}

function Args({ args }: { args?: Record<string, unknown> }) {
  const entries = Object.entries(args || {});
  if (!entries.length) return <code className="audit-args">no arguments</code>;
  return <code className="audit-args">{entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")}</code>;
}

function Step({ step }: { step: AuditStep }) {
  const { icon: Icon, label } = describeStep(step);
  return (
    <li className={`audit-step ${step.kind} ${step.error ? "failed" : ""}`}>
      <span className="audit-icon">
        <Icon size={13} />
      </span>
      <div>
        <div className="audit-step-head">
          <strong>{step.kind === "tool" ? step.name : label}</strong>
          <span>
            +{seconds(step.at)}
            {step.latencyMs != null && ` · ${seconds(step.latencyMs)}`}
          </span>
        </div>
        {step.thought && (
          <details>
            <summary>Reasoning summary</summary>
            <p className="audit-thought">{step.thought}</p>
          </details>
        )}
        {step.kind === "plan" && step.calls && (
          <ul className="audit-calls">
            {step.calls.map((c, i) => (
              <li key={i}>
                → <b>{c.name}</b> <Args args={c.args} />
              </li>
            ))}
          </ul>
        )}
        {step.kind === "tool" && (
          <>
            <Args args={step.args} />
            {step.error ? (
              <p className="audit-error">{step.error}</p>
            ) : step.name === "calculate" ? (
              <p className="audit-note">
                {step.expression} = <b>{step.result}</b>
              </p>
            ) : (
              <p className="audit-note">
                {label}: {step.count} result{step.count === 1 ? "" : "s"}
                {step.totalStockValueUsd != null && ` · total ${usd(step.totalStockValueUsd)}`}
              </p>
            )}
            {!!step.results?.length && (
              <ol className="audit-results">
                {step.results.map((r) => (
                  <li key={r.ref}>
                    <span className="audit-ref">[{r.ref}]</span>
                    <span className="audit-type">{r.type}</span>
                    <span className="audit-title">{r.title}</span>
                    {r.score != null && <span className="audit-score">{r.score.toFixed(3)}</span>}
                    {r.excerpt && (
                      <details>
                        <summary>Retrieved text</summary>
                        <p>{r.excerpt}…</p>
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
        {step.kind === "draft" && step.excerpt && (
          <details>
            <summary>Draft text</summary>
            <p className="audit-thought">{step.excerpt}</p>
          </details>
        )}
        {step.kind === "review" && (
          <ul className="audit-problems">
            {step.problems?.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
        {step.tokens && (step.kind === "plan" || step.kind === "answer" || step.kind === "draft") && (
          <p className="audit-tokens">
            {step.tokens.prompt ?? 0} in · {step.tokens.output ?? 0} out · {step.tokens.thinking ?? 0} thinking tokens
          </p>
        )}
      </div>
    </li>
  );
}

export const passed = (audit: Audit) => audit.status === "ok" && audit.checks.every((c) => c.ok);

export function AuditView({ audit }: { audit: Audit }) {
  const ok = passed(audit);
  const tools = audit.steps.filter((s) => s.kind === "tool").length;
  return (
    <div className="audit">
      <div className="audit-head">
        <span className={`audit-badge ${ok ? "ok" : "warn"}`}>
          {ok ? <CircleCheck size={12} /> : <CircleAlert size={12} />}
          {ok ? "Checks passed" : "Needs review"}
        </span>
        <span>
          {tools} tool call{tools === 1 ? "" : "s"} · {audit.usage.modelCalls} model call{audit.usage.modelCalls === 1 ? "" : "s"} ·{" "}
          {seconds(audit.latencyMs)}
        </span>
      </div>
      <ul className="audit-checks">
        {audit.checks.map((c) => (
          <li key={c.name} className={c.ok ? "ok" : "warn"}>
            {c.ok ? <CircleCheck size={12} /> : <CircleAlert size={12} />}
            <span>
              <b>{c.name}.</b> {c.detail}
            </span>
          </li>
        ))}
      </ul>
      <ol className="audit-steps">
        {audit.steps.map((s, i) => (
          <Step key={i} step={s} />
        ))}
      </ol>
      <dl className="audit-meta">
        <dt>Model</dt>
        <dd>{audit.model}</dd>
        <dt>Embeddings</dt>
        <dd>{audit.embeddingModel}</dd>
        <dt>Tokens</dt>
        <dd>
          {audit.usage.promptTokens.toLocaleString()} in · {audit.usage.outputTokens.toLocaleString()} out ·{" "}
          {audit.usage.thinkingTokens.toLocaleString()} thinking
        </dd>
        <dt>Evidence</dt>
        <dd>
          {audit.retrieved.length} retrieved · {audit.citations.length} cited
        </dd>
        <dt>Record</dt>
        <dd>
          <code>audits/{audit.id}</code> in Firestore
        </dd>
      </dl>
      <button type="button" className="audit-download" onClick={() => downloadJson(`exportmate-audit-${audit.id}.json`, audit)}>
        <Download size={12} /> Download audit JSON
      </button>
    </div>
  );
}
