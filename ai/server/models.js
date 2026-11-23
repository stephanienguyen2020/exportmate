// Which Gemini model does what: one model, GEMINI_MODEL, for the whole AI service (the
// assistant's agents and critic, the news scan and the eval judge). Until 23 Nov 2026 the
// assistant had two tiers (flash-lite for lookups, gemini-4-argon for harder questions); argon
// answered most calls with 429 and the small model saved no time, so while we develop there is
// one. router.js still picks which agent answers (quick_answer or the analyst).
// Models are given a thinking level, not a budget: Gemini 4 rejects thinking budgets. Gemini 2.x
// models reject a level (400 "thinking_level is not supported"), so they get none and think
// dynamically; GEMINI_MODEL set to gemini-2.5-flash stopped every scan that way.
export const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";

// The assistant thinks at LOW: the egress gateway ends Agent Runtime requests after 60 s.
// timeoutMs: one model call taking longer is abandoned and retried (single calls sometimes stall
// for over a minute while their usual time is a few seconds).
export const ASSISTANT = { model: MODEL, thinkingLevel: process.env.GEMINI_THINKING_ASSISTANT || "LOW", timeoutMs: 45_000 };

export const SCAN_MODEL = MODEL;
export const SCAN_THINKING = process.env.GEMINI_THINKING_SCAN || "MEDIUM";

// Where Gemini is called. The newest models are served from the global endpoint; Agent Runtime
// sets GOOGLE_CLOUD_LOCATION to its own region, so Gemini has its own setting.
export const GEMINI_LOCATION = process.env.GEMINI_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || "global";

/** A thinkingConfig for `model` at `thinkingLevel`, leaving the level out for models that reject it. */
export const thinkingConfig = (model, thinkingLevel, extra = {}) => ({
  ...(/^gemini-2\./.test(model) ? {} : { thinkingLevel }),
  ...extra,
});

/** The assistant's generation settings. */
export const assistantThinking = (includeThoughts = true) => thinkingConfig(ASSISTANT.model, ASSISTANT.thinkingLevel, { includeThoughts });
