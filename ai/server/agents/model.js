// The Gemini client every agent shares. Each call names its model and thinking level
// (agents/assistant.js), so one client serves both tiers.
import { Gemini } from "@google/adk";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { PROJECT } from "../db.js";
import { withRetry } from "../gateway.js";
import { GEMINI_LOCATION, TIERS, timeoutFor } from "../models.js";

// ADK's Gemini model, with transient errors (429, 503, timeouts) retried with backoff, and each
// call bounded by its tier's timeout (a stalled call counts as a timeout and is retried).
// The attempt count rides on the response so the audit can show retried steps.
// ADK's call_llm span (the active one here) gets the model, each retry as an event and a final
// failure as an error, which ADK leaves out when the call fails: Cloud Trace shows it in red.
class RetryingGemini extends Gemini {
  async *generateContentAsync(request, stream, abortSignal) {
    let attempts = 0;
    const model = request.model ?? this.model;
    const ms = timeoutFor(model);
    const span = trace.getActiveSpan();
    span?.setAttribute("gen_ai.request.model", model);
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
    }, { onRetry: (e, attempt) => span?.addEvent("retry", { attempt, ...errorAttributes(e) }) }).catch((e) => {
      span?.recordException(e);
      span?.setAttributes(errorAttributes(e));
      span?.setStatus({ code: SpanStatusCode.ERROR, message: errorAttributes(e)["error.message"] });
      throw e;
    });
    for (const r of responses) yield { ...r, customMetadata: { ...r.customMetadata, attempts } };
  }
}
/** A model error as span attributes: its HTTP status (429, 404…) or kind (TimeoutError), and message. */
export const errorAttributes = (e) => ({
  "error.type": String(e?.status ?? e?.code ?? e?.name ?? "error"),
  "error.message": String(e?.message || e).slice(0, 300),
});

export const gemini = new RetryingGemini({
  model: TIERS.simple.model,
  vertexai: true,
  project: PROJECT,
  location: GEMINI_LOCATION,
});

