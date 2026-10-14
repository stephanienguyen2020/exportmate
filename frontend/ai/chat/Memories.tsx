// Account › What the assistant remembers: the signed-in user's Memory Bank memories, each of
// which they can delete. Shown in company workspaces only (the demo has no memory).
import { useEffect, useState } from "react";
import { Bookmark, Trash2 } from "lucide-react";
import { deleteMemory, listMemories, type Memory } from "./agent-client";

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; memories: Memory[]; enabled: boolean };

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

export function AssistantMemories() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    let live = true;
    listMemories()
      .then((data) => live && setState({ status: "ready", ...data }))
      .catch((e: Error) => live && setState({ status: "error", message: e.message }));
    return () => {
      live = false;
    };
  }, []);

  async function forget(memory: Memory) {
    if (state.status !== "ready" || busy) return;
    setBusy(memory.id);
    setNote("");
    try {
      await deleteMemory(memory.id);
      setState({ ...state, memories: state.memories.filter((m) => m.id !== memory.id) });
      setNote("Forgotten.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel ac-memories" aria-labelledby="assistant-memories">
      <h2 id="assistant-memories">What the assistant remembers</h2>
      <p className="ac-muted">
        From your own chats, the assistant keeps your preferences and what you work on, for 180 days, so it doesn't have to ask again. Only you
        see them; colleagues have their own. They shape how it answers, never the figures.
      </p>
      {state.status === "loading" && <p className="ac-muted">Loading…</p>}
      {state.status === "error" && <p className="ac-muted">{state.message}</p>}
      {state.status === "ready" && !state.enabled && <p className="ac-muted">Memory isn't switched on for this workspace yet.</p>}
      {state.status === "ready" && state.enabled && state.memories.length === 0 && (
        <p className="ac-muted">Nothing yet. Tell the assistant how you like answers or what you work on, and it will remember.</p>
      )}
      {state.status === "ready" && state.memories.length > 0 && (
        <ul className="ac-memory-list">
          {state.memories.map((m) => (
            <li key={m.id}>
              <Bookmark size={14} aria-hidden="true" />
              <span>
                {m.fact}
                {m.updatedAt && <small>{day(m.updatedAt)}</small>}
              </span>
              <button type="button" className="ac-memory-forget" onClick={() => forget(m)} disabled={busy === m.id} aria-label={`Forget: ${m.fact}`}>
                <Trash2 size={14} />
                Forget
              </button>
            </li>
          ))}
        </ul>
      )}
      <span role="status" className="ac-muted">
        {note}
      </span>
    </section>
  );
}
