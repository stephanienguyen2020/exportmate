// Untrusted-content guard. News articles, feed titles and the alerts derived from
// them are written by third parties (any company owner or editor can add a feed),
// so the harness treats their text as data, never as instructions:
// - passages that address the assistant (prompt injection) are withheld before the
//   model sees them, and each removal is recorded in the audit;
// - text placed inside a prompt is fenced so it can't close or open a section.
// The tools are read-only as well, so injected text has no action to trigger.

export const WITHHELD = "[removed: this passage contained instructions aimed at the assistant]";

// Phrases aimed at a language model rather than a reader. Kept narrow so ordinary
// trade news ("exporters ignored the rules", "acts as a deterrent") is not caught.
const PATTERNS = [
  /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,30}\b(previous|prior|above|earlier|preceding|original|all|any|your|system)\b[^.\n]{0,20}\b(instructions?|prompts?|directions|commands)\b/i,
  /\b(system|developer|hidden) prompt\b/i,
  /\breveal\b[^.\n]{0,30}\b(your|the|system)\b[^.\n]{0,10}\b(prompt|instructions)\b/i,
  /\b(new|updated|additional) instructions?\s*:/i,
  /\b(instructions?|note|message) (for|to) (the )?(ai|assistant|chatbot|language model|llm)\b/i,
  /\b(from now on,? you (are|will|must)|pretend (to be|you are))\b/i,
  /<\|?(im_start|im_end|endoftext)\|?>|\[\/?(INST|SYS)\]|<\/?(system|instructions?)>/i,
  /\b(DAN mode|do anything now|developer mode enabled|jailbreak)\b/i,
  /\b(send|email|forward|post|upload)\b[^.\n]{0,40}\b(conversation|chat history|system prompt|api key|password|credentials|access token)\b/i,
];

/** The first phrase in text that addresses the assistant, or null. */
export function findInjection(text) {
  const s = String(text ?? "");
  for (const p of PATTERNS) {
    const m = s.match(p);
    if (m) return m[0].slice(0, 80);
  }
  return null;
}

/** Collects the passages withheld while building one tool result. */
export function createGuard() {
  const flags = [];
  return {
    flags,
    /** Returns text unchanged, or WITHHELD (and records where) if it addresses the assistant. */
    clean(text, where) {
      const match = findInjection(text);
      if (!match) return text;
      flags.push({ where, match });
      return WITHHELD;
    },
  };
}

/** Fences third-party text for a prompt: angle brackets can't open or close a tagged section. */
export const asData = (text) => String(text ?? "").replace(/</g, "‹").replace(/>/g, "›");
