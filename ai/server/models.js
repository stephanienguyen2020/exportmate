// Which Gemini model does what. The assistant answers each question on a tier chosen by
// router.js: a small fast model for lookups, the bigger latest model for questions that
// need reasoning. The news scan and the eval judge use GEMINI_MODEL.
// Every model is given a thinking level, not a budget: Gemini 4 rejects thinking budgets.
// Complex runs at MEDIUM: in the golden set HIGH passed the same cases but made up to 13 tool
// calls per answer (p95 91 s against 46 s).

export const TIERS = {
  simple: { model: process.env.GEMINI_MODEL_SIMPLE || "gemini-3.5-flash-lite", thinkingLevel: process.env.GEMINI_THINKING_SIMPLE || "LOW" },
  complex: { model: process.env.GEMINI_MODEL_COMPLEX || "gemini-4-argon", thinkingLevel: process.env.GEMINI_THINKING_COMPLEX || "MEDIUM" },
};

export const SCAN_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";

/** The generation settings that go with a tier's model. */
export const thinkingFor = (tier, includeThoughts = true) => ({ thinkingLevel: TIERS[tier].thinkingLevel, includeThoughts });
