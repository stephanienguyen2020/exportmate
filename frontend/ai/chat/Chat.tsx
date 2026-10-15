import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CircleAlert,
  Download,
  Loader2,
  Maximize2,
  MessageCircle,
  Send,
  ShieldCheck,
  SquarePen,
  X,
} from "lucide-react";
import {
  askAgent,
  downloadJson,
  sessionAudits,
  sessionId,
  type Audit,
  type AuditStep,
  type Citation,
  type Message,
} from "./agent-client";
import { AuditView, describeStep, passed } from "./Audit";
import "./chat.css";

const KEY = "em-chat";
const RESET_EVENT = "em-chat-reset";
// Longest wait for an answer before the UI gives up (the agent makes several model calls).
const ANSWER_TIMEOUT_MS = 120_000;

/** Forgets the conversation and starts a new audit session: "New chat", and on sign-out. */
export function clearChat() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* Storage may be unavailable. */
  }
  sessionId(true);
  window.dispatchEvent(new Event(RESET_EVENT));
}
const suggestions = [
  "Which EU-bound items are missing geolocation data?",
  "What did the latest news scan flag?",
  "How much stock is exposed to US plywood trade cases?",
  "How do I import my orders?",
];

function load(): Message[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function CiteLink({ n, citation }: { n: number; citation?: Citation }) {
  if (!citation) return <span className="chat-cite missing">{n}</span>;
  const label = `${citation.type}: ${citation.title}`;
  if (citation.url?.startsWith("http"))
    return (
      <a className="chat-cite" href={citation.url} target="_blank" rel="noopener noreferrer" title={label}>
        {n}
      </a>
    );
  if (citation.url?.startsWith("#"))
    return (
      <a className="chat-cite" href={citation.url} title={label}>
        {n}
      </a>
    );
  return (
    <span className="chat-cite" title={label}>
      {n}
    </span>
  );
}

function inline(text: string, citations: Citation[]) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[\d+(?:\s*,\s*\d+)*\])/g).map((part, i) => {
    if (/^`[^`]+`$/.test(part)) return <code key={i}>{part.slice(1, -1)}</code>;
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    const refs = part.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/);
    if (refs)
      return (
        <sup key={i} className="chat-cites">
          {refs[1].split(/\s*,\s*/).map((n) => (
            <CiteLink key={n} n={Number(n)} citation={citations.find((c) => c.ref === Number(n))} />
          ))}
        </sup>
      );
    return part;
  });
}

/** Renders the markdown subset Gemini uses: paragraphs, bullets, bold, `code`, headings, [n] citations. */
function Rich({ text, citations = [] }: { text: string; citations?: Citation[] }) {
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length)
      blocks.push(
        <ul key={blocks.length}>
          {list.map((item, i) => (
            <li key={i}>{inline(item, citations)}</li>
          ))}
        </ul>,
      );
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = line.match(/^(?:[*-]|\d+\.)\s+(.*)/);
    if (bullet) list.push(bullet[1]);
    else {
      flush();
      if (line) blocks.push(<p key={blocks.length}>{inline(line.replace(/^#+\s*/, ""), citations)}</p>);
    }
  }
  flush();
  return <>{blocks}</>;
}

function Sources({ citations }: { citations: Citation[] }) {
  return (
    <ol className="chat-sources" aria-label="Sources">
      {citations.map((c) => (
        <li key={c.ref}>
          <span className="chat-src-ref">{c.ref}</span>
          <span className="chat-src-type">{c.type}</span>
          {c.url?.startsWith("http") ? (
            <a href={c.url} target="_blank" rel="noopener noreferrer">
              {c.title}
            </a>
          ) : c.url?.startsWith("#") ? (
            <a href={c.url}>{c.title}</a>
          ) : (
            <span>{c.title}</span>
          )}
          {(c.source || c.publishedAt) && (
            <small>{[c.source, c.publishedAt?.slice(0, 10)].filter(Boolean).join(" · ")}</small>
          )}
        </li>
      ))}
    </ol>
  );
}

function Answer({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const audit = message.audit;
  const tools = audit?.steps.filter((s) => s.kind === "tool").length ?? 0;
  const ok = audit ? passed(audit) : true;
  return (
    <div className="chat-msg model">
      <Rich text={message.text} citations={message.citations} />
      {!!message.citations?.length && <Sources citations={message.citations} />}
      {audit && (
        <>
          <button type="button" className={`chat-audit-toggle ${ok ? "" : "warn"}`} aria-expanded={open} onClick={() => setOpen(!open)}>
            {ok ? <ShieldCheck size={13} /> : <CircleAlert size={13} />}
            Audit · {tools} tool call{tools === 1 ? "" : "s"} · {(audit.latencyMs / 1000).toFixed(1)}s ·{" "}
            {ok ? "checks passed" : "needs review"}
          </button>
          {open && <AuditView audit={audit} />}
        </>
      )}
    </div>
  );
}

function Activity({ steps }: { steps: AuditStep[] }) {
  return (
    <div className="chat-msg model pending" role="status">
      <div className="chat-activity-head">
        <Loader2 size={14} className="spin" /> Working…
      </div>
      {steps.length > 0 && (
        <ol className="chat-activity">
          {steps.map((s, i) => {
            const { icon: Icon, label, detail } = describeStep(s);
            return (
              <li key={i}>
                <Icon size={12} />
                <span>
                  {label}
                  {detail && <small> · {detail}</small>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function useConversation(onAudit?: () => void) {
  const [messages, setMessages] = useState<Message[]>(load);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<AuditStep[]>([]);
  const [error, setError] = useState("");
  // Bumped by a reset, so an answer still arriving for the old conversation is dropped.
  const generation = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(messages));
    } catch {
      /* Storage may be unavailable or full. */
    }
  }, [messages]);
  useEffect(() => {
    const clear = () => {
      generation.current++;
      inFlight.current?.abort();
      setMessages([]);
      setSteps([]);
      setError("");
      setBusy(false);
    };
    window.addEventListener(RESET_EVENT, clear);
    return () => {
      window.removeEventListener(RESET_EVENT, clear);
      generation.current++;
      inFlight.current?.abort();
    };
  }, []);
  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const turn = ++generation.current;
    const next: Message[] = [...messages, { role: "user", text: q }];
    setMessages(next);
    setBusy(true);
    setSteps([]);
    setError("");
    const controller = new AbortController();
    inFlight.current = controller;
    const timer = setTimeout(
      () => controller.abort(new Error("The assistant took too long to answer. Please try again.")),
      ANSWER_TIMEOUT_MS,
    );
    try {
      const { reply, citations, audit } = await askAgent(
        next,
        (s) => turn === generation.current && setSteps((prev) => [...prev, s]),
        controller.signal,
      );
      if (turn !== generation.current) return;
      setMessages([...next, { role: "model", text: reply, citations, audit }]);
      onAudit?.();
    } catch (e) {
      if (turn !== generation.current) return;
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      clearTimeout(timer);
      if (turn === generation.current) setBusy(false);
    }
  };
  return { messages, busy, steps, error, ask };
}

function Conversation({ autoFocus, onAudit }: { autoFocus?: boolean; onAudit?: () => void }) {
  const { messages, busy, steps, error, ask } = useConversation(onAudit);
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, busy, steps]);
  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    ask(draft);
    setDraft("");
  };
  return (
    <div className="chat-body">
      <div className="chat-log" aria-live="polite">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>
              Ask about your stock, today's news alerts, export rules, or how to use ExportMate. Every answer cites its
              sources and comes with an audit trail.
            </p>
            <div className="chat-suggest">
              {suggestions.map((s) => (
                <button key={s} type="button" onClick={() => ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "model" ? (
            <Answer key={i} message={m} />
          ) : (
            <div key={i} className="chat-msg user">
              {m.text}
            </div>
          ),
        )}
        {busy && <Activity steps={steps} />}
        {error && (
          <div className="chat-error" role="alert">
            {error}
          </div>
        )}
        <div ref={end} />
      </div>
      <form className="chat-input" onSubmit={submit}>
        <textarea
          value={draft}
          rows={1}
          autoFocus={autoFocus}
          placeholder="Ask a question…"
          aria-label="Message"
          maxLength={4000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Not while an input method (e.g. Vietnamese or Japanese) is still composing.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
          }}
        />
        <button type="submit" disabled={busy || !draft.trim()} aria-label="Send">
          <Send size={17} />
        </button>
      </form>
      <div className="chat-foot">
        <span>Gemini agent on Vertex AI · answers are logged for audit; verify rules.</span>
      </div>
    </div>
  );
}

function SessionAudit({ version }: { version: number }) {
  const [audits, setAudits] = useState<Audit[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    sessionAudits()
      .then((a) => live && (setAudits(a), setError("")))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [version]);
  return (
    <aside className="chat-audit-panel" aria-label="Audit trail">
      <div className="chat-audit-panel-head">
        <div>
          <h2>Audit trail</h2>
          <p>Every answer in this conversation, as stored in Firestore.</p>
        </div>
        {!!audits?.length && (
          <button type="button" onClick={() => downloadJson(`exportmate-session-${sessionId()}.json`, audits)}>
            <Download size={13} /> JSON
          </button>
        )}
      </div>
      {error && <p className="chat-error">{error}</p>}
      {!audits && !error && (
        <p className="chat-audit-empty">
          <Loader2 size={14} className="spin" /> Loading…
        </p>
      )}
      {audits?.length === 0 && <p className="chat-audit-empty">Ask a question to start the audit trail.</p>}
      {audits?.map((a) => (
        <details key={a.id} className="chat-audit-entry">
          <summary>
            <span className={`audit-dot ${passed(a) ? "ok" : "warn"}`} />
            <span className="chat-audit-q">{a.question}</span>
            <small>
              {new Date(a.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} ·{" "}
              {a.steps.filter((s) => s.kind === "tool").length} tools · {(a.latencyMs / 1000).toFixed(1)}s
            </small>
          </summary>
          <AuditView audit={a} />
        </details>
      ))}
    </aside>
  );
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        launcher.current?.focus();
      }
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  return (
    <>
      {open && (
        <section className="chat-panel" role="dialog" aria-label="ExportMate assistant">
          <header>
            <strong>ExportMate assistant</strong>
            <button type="button" aria-label="New chat" title="New chat" onClick={clearChat}>
              <SquarePen size={16} />
            </button>
            <a href="#/chat" aria-label="Open full screen with audit trail" onClick={() => setOpen(false)}>
              <Maximize2 size={16} />
            </a>
            <button type="button" aria-label="Close chat" onClick={() => setOpen(false)}>
              <X size={18} />
            </button>
          </header>
          <Conversation autoFocus />
        </section>
      )}
      <button
        ref={launcher}
        type="button"
        className="chat-launcher"
        data-tour="chat"
        aria-label={open ? "Close assistant" : "Open assistant"}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <X size={22} /> : <MessageCircle size={22} />}
      </button>
    </>
  );
}

export default function ChatPage() {
  const [version, setVersion] = useState(0);
  const newChat = () => {
    clearChat();
    setVersion((v) => v + 1);
  };
  return (
    <main className="chat-page">
      <header>
        <button type="button" onClick={() => history.back()} aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <div>
          <span className="chat-kicker">ExportMate · RAG agent</span>
          <h1>Assistant</h1>
        </div>
        <button type="button" className="chat-new" onClick={newChat}>
          <SquarePen size={15} /> New chat
        </button>
      </header>
      <div className="chat-page-grid">
        <Conversation autoFocus onAudit={() => setVersion((v) => v + 1)} />
        <SessionAudit version={version} />
      </div>
    </main>
  );
}
