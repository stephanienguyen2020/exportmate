// Which Gemini model does what. The assistant answers each question on a tier chosen by
// router.js: a small fast model for lookups, the bigger latest model for questions that
// need reasoning. The news scan and the eval judge use GEMINI_MODEL.
// Models are given a thinking level, not a budget: Gemini 4 rejects thinking budgets. Gemini 2.x
// models reject a level (400 "thinking_level is not supported"), so they get none and think
// dynamically; GEMINI_MODEL set to gemini-2.5-flash stopped every scan that way.
// Complex runs at MEDIUM: in the golden set HIGH passed the same cases but made up to 13 tool
// calls per answer (p95 91 s against 46 s).

// timeoutMs: one model call taking longer is abandoned and retried. In the golden set single
// flash-lite calls sometimes stalled for 70-90 s while their usual time is 1-5 s.
export const TIERS = {
  simple: { model: process.env.GEMINI_MODEL_SIMPLE || "gemini-3.5-flash-lite", thinkingLevel: process.env.GEMINI_THINKING_SIMPLE || "LOW", timeoutMs: 25_000 },
  complex: { model: process.env.GEMINI_MODEL_COMPLEX || "gemini-4-argon", thinkingLevel: process.env.GEMINI_THINKING_COMPLEX || "MEDIUM", timeoutMs: 90_000 },
};

/** How long one call to `model` may take before it is retried. */
export const timeoutFor = (model) => Object.values(TIERS).find((t) => t.model === model)?.timeoutMs ?? 90_000;

export const SCAN_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
export const SCAN_THINKING = process.env.GEMINI_THINKING_SCAN || "MEDIUM";

// Where Gemini is called. The newest models are served from the global endpoint; Agent Runtime
// sets GOOGLE_CLOUD_LOCATION to its own region, so Gemini has its own setting.
export const GEMINI_LOCATION = process.env.GEMINI_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || "global";

/** A thinkingConfig for `model` at `thinkingLevel`, leaving the level out for models that reject it. */
export const thinkingConfig = (model, thinkingLevel, extra = {}) => ({
  ...(/^gemini-2\./.test(model) ? {} : { thinkingLevel }),
  ...extra,
});

/** The generation settings that go with a tier's model. */
export const thinkingFor = (tier, includeThoughts = true) => thinkingConfig(TIERS[tier].model, TIERS[tier].thinkingLevel, { includeThoughts });
