// The Gemini client every agent shares. Each call names its model and thinking level (agent.js).
import { Gemini } from "@google/adk";
import { GEMINI_PROJECT } from "../db.js";
import { withRetry } from "../gateway.js";
import { ASSISTANT, GEMINI_LOCATION } from "../models.js";

// ADK's Gemini model, with transient errors (429, 503, timeouts) retried with backoff, and each
// call bounded by a timeout (a stalled call counts as a timeout and is retried).
// The attempt count rides on the response so the audit can show retried steps.
class RetryingGemini extends Gemini {
  async *generateContentAsync(request, stream, abortSignal) {
    let attempts = 0;
    const ms = ASSISTANT.timeoutMs;
    const responses = await withRetry(async () => {
      attempts++;
      const attempt = new AbortController();
      const stop = () => attempt.abort();
      abortSignal?.addEventListener("abort", stop, { once: true });
      let timer;
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => {
          attempt.abort();
          reject(Object.assign(new Error(`Model call took over ${ms / 1000}s`), { name: "TimeoutError" }));
        }, ms);
      });
      const collect = (async () => {
        const out = [];
        for await (const r of super.generateContentAsync(request, stream, attempt.signal)) out.push(r);
        return out;
      })();
      try {
        return await Promise.race([collect, timedOut]);
      } finally {
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", stop);
        collect.catch(() => {}); // an abandoned attempt may still reject later
      }
    });
    for (const r of responses) yield { ...r, customMetadata: { ...r.customMetadata, attempts } };
  }
}
export const gemini = new RetryingGemini({
  model: ASSISTANT.model,
  vertexai: true,
  project: GEMINI_PROJECT,
  location: GEMINI_LOCATION,
});

