// Structured logs. On Cloud Run (K_SERVICE is set) each line is JSON, which Cloud
// Logging parses into severity, message and searchable fields, grouped by trace.
// Locally lines are plain text. Never log tokens, question text or file contents.
import { PROJECT } from "./db.js";

const JSON_LINES = Boolean(process.env.K_SERVICE);

/** severity: DEBUG | INFO | WARNING | ERROR. `trace` is the X-Cloud-Trace-Context header, if any. */
export function log(severity, message, { trace, ...fields } = {}) {
  if (JSON_LINES) {
    const traceId = typeof trace === "string" ? trace.split("/")[0] : "";
    const line = { severity, message, ...fields };
    if (traceId) line["logging.googleapis.com/trace"] = `projects/${PROJECT}/traces/${traceId}`;
    (severity === "ERROR" ? console.error : console.log)(JSON.stringify(line));
    return;
  }
  const extra = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" ");
  (severity === "ERROR" ? console.error : severity === "WARNING" ? console.warn : console.log)(`${message}${extra ? ` ${extra}` : ""}`);
}
