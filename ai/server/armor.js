// Model Armor (Google Cloud) screening for third-party text, alongside guard.js. The
// patterns in guard.js catch the usual phrasings offline and for free; Model Armor is a
// trained prompt-injection and jailbreak classifier that also catches reworded attempts,
// and it flags links to known-malicious sites. The scan screens every new article with
// both before Gemini or the vector index sees it (scan.js).
// Off when MODEL_ARMOR_TEMPLATE is unset (local runs, tests); the patterns still apply.
import { pathToFileURL } from "node:url";
import { GoogleAuth } from "google-auth-library";
import { withRetry } from "./gateway.js";

// How a withheld article names each filter, by its key in the sanitize result.
const LABELS = {
  pi_and_jailbreak: "prompt injection or jailbreak",
  malicious_uris: "malicious link",
  csam: "child safety",
  rai: "harmful content",
  sdp: "sensitive data",
};
const OK_STATES = new Set(["EXECUTION_SUCCESS", "EXECUTION_SKIPPED"]);
// The prompt-injection filter reads the first 10,000 tokens; feed snippets are far shorter.
const MAX_CHARS = 30_000;
const TIMEOUT_MS = 10_000;
const TEMPLATE = /^projects\/[^/]+\/locations\/([^/]+)\/templates\/[^/]+$/;

/**
 * Reads a sanitizeUserPrompt response: null when nothing matched, otherwise what matched,
 * e.g. "model armor: prompt injection or jailbreak (HIGH)". Throws when the text was not
 * screened, so the caller can try again later rather than let it through.
 */
export function verdict(response) {
  const result = response?.sanitizationResult;
  if (!result || result.invocationResult === "FAILURE") throw new Error("Model Armor could not screen the text");
  const injection = result.filterResults?.pi_and_jailbreak?.piAndJailbreakFilterResult;
  if (injection && !OK_STATES.has(injection.executionState))
    throw new Error(`Model Armor's prompt-injection filter did not run (${injection.executionState})`);

  const matched = [];
  for (const [key, wrapper] of Object.entries(result.filterResults || {})) {
    const filter = Object.values(wrapper || {})[0] || {};
    if ((filter.matchState ?? filter.inspectResult?.matchState) !== "MATCH_FOUND") continue;
    const label = LABELS[key] || key;
    matched.push(filter.confidenceLevel ? `${label} (${filter.confidenceLevel})` : label);
  }
  return matched.length ? `model armor: ${matched.join(", ")}` : null;
}

let auth;
const accessToken = async () => {
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return auth.getAccessToken();
};

/** template: projects/<project>/locations/<location>/templates/<id>. fetch, getToken and sleep are replaceable for tests. */
export function createArmor({ template, fetch = globalThis.fetch, getToken = accessToken, sleep } = {}) {
  if (!template) return { enabled: false, screen: async () => null, screenEach: async (texts) => texts.map(() => ({ match: null })) };
  const location = template.match(TEMPLATE)?.[1];
  if (!location) throw new Error(`MODEL_ARMOR_TEMPLATE must look like projects/<project>/locations/<location>/templates/<id>, not ${template}`);
  // Sanitizing is only served from the template's regional endpoint.
  const url = `https://modelarmor.${location}.rep.googleapis.com/v1/${template}:sanitizeUserPrompt`;

  /** The verdict for one text; throws (after retrying transient errors) if it could not be screened. */
  const screen = (text) =>
    withRetry(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${await getToken()}`, "content-type": "application/json" },
          body: JSON.stringify({ userPromptData: { text: String(text ?? "").slice(0, MAX_CHARS) } }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          const e = new Error(`Model Armor returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
          e.status = res.status;
          throw e;
        }
        return verdict(await res.json());
      },
      sleep ? { sleep } : {},
    );

  /** Screens texts a few at a time; one { match } or { error } per text, in order. */
  async function screenEach(texts, { concurrency = 8 } = {}) {
    const out = new Array(texts.length);
    let next = 0;
    const worker = async () => {
      while (next < texts.length) {
        const n = next++;
        try {
          out[n] = { match: await screen(texts[n]) };
        } catch (error) {
          out[n] = { error };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
    return out;
  }

  return { enabled: true, screen, screenEach };
}

export const armor = createArmor({ template: process.env.MODEL_ARMOR_TEMPLATE });

// `node armor.js "<text>"` screens one text with MODEL_ARMOR_TEMPLATE, to check the setup.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!armor.enabled) throw new Error("Set MODEL_ARMOR_TEMPLATE=projects/<project>/locations/<location>/templates/<id>");
  console.log((await armor.screen(process.argv.slice(2).join(" "))) ?? "no match");
}
