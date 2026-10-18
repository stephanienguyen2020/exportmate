// Tool gateway. The model never runs a tool itself: every call it asks for goes
// through call(), which looks the tool up in the registry, checks the session may
// use it, validates the arguments against the declared schema, enforces the
// per-turn budget, runs the handler with a timeout and retries transient failures.
// It returns a record for the audit whatever happens, so failed calls are as
// visible as successful ones.

export class ToolError extends Error {
  /** kind: invalid_args | denied | budget | unknown_tool | timeout | unavailable | failed */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const TRANSIENT_HTTP = new Set([408, 429, 502, 503, 504]);
// gRPC codes from Firestore: DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, ABORTED, UNAVAILABLE.
const TRANSIENT_GRPC = new Set([4, 8, 10, 14]);

/** Worth retrying: timeouts, network drops, 429 and 5xx overload. Never 400/401/403/404 or bad input. */
export function isTransient(e) {
  if (!e) return false;
  if (e instanceof ToolError) return e.kind === "timeout";
  if (TRANSIENT_HTTP.has(Number(e.status))) return true;
  if (typeof e.code === "number" && TRANSIENT_GRPC.has(e.code)) return true;
  if (e.name === "TimeoutError") return true;
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(`${e.message} ${e.cause?.code || ""}`);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs fn, retrying transient failures with exponential backoff. onRetry(error, attempt) is called before each retry. */
export async function withRetry(fn, { retries = 2, baseMs = 500, sleep = pause, onRetry = () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt > retries || !isTransient(e)) throw e;
      onRetry(e, attempt);
      await sleep(baseMs * 2 ** (attempt - 1));
    }
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ToolError("timeout", `Timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const MAX_STRING = 500;
const MAX_ITEMS = 50;

function checkValue(schema, value, path, problems) {
  const type = String(schema.type || "").toUpperCase();
  if (type === "STRING") {
    if (typeof value !== "string") return problems.push(`${path} must be a string`);
    if (value.length > MAX_STRING) problems.push(`${path} is longer than ${MAX_STRING} characters`);
    if (schema.enum && !schema.enum.includes(value)) problems.push(`${path} must be one of ${schema.enum.join(", ")}`);
  } else if (type === "INTEGER") {
    if (!Number.isInteger(value)) problems.push(`${path} must be a whole number`);
  } else if (type === "NUMBER") {
    if (typeof value !== "number" || !Number.isFinite(value)) problems.push(`${path} must be a number`);
  } else if (type === "BOOLEAN") {
    if (typeof value !== "boolean") problems.push(`${path} must be true or false`);
  } else if (type === "ARRAY") {
    if (!Array.isArray(value)) return problems.push(`${path} must be a list`);
    if (value.length > MAX_ITEMS) problems.push(`${path} has more than ${MAX_ITEMS} items`);
    if (schema.items) value.forEach((v, n) => checkValue(schema.items, v, `${path}[${n}]`, problems));
  } else if (type === "OBJECT") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return problems.push(`${path} must be an object`);
    const props = schema.properties || {};
    for (const key of Object.keys(value)) {
      if (!(key in props)) problems.push(`unknown argument ${path ? `${path}.` : ""}${key}`);
      else if (value[key] != null) checkValue(props[key], value[key], path ? `${path}.${key}` : key, problems);
    }
    for (const key of schema.required || []) if (value[key] == null) problems.push(`${key} is required`);
  }
}

/** Checks args against a function declaration's `parameters` (Gemini schema). Returns the problems found. */
export function validateArgs(parameters, args) {
  const problems = [];
  if (!parameters) {
    if (args && Object.keys(args).length) problems.push(`this tool takes no arguments`);
    return problems;
  }
  checkValue(parameters, args ?? {}, "", problems);
  return problems;
}

// Why a tool outside the session's scope is refused.
const SCOPE_NEEDS = {
  company: "a signed-in company workspace",
  orders: "a workspace with orders",
  playbook: "a workspace with a playbook",
  graph: "a signed-in company workspace",
};

/**
 * One gateway per agent turn (the budget is per turn).
 * registry: { [name]: { declaration, scope: "public" | "company" | "orders" | "playbook" | "graph", run(args, ctx), timeoutMs?, maxCalls? } }
 * ctx is passed to every handler; a tool whose scope isn't "public" runs only when ctx[scope]
 * is present (`ctx.company` for a signed-in company, `ctx.orders` / `ctx.playbook` readers).
 */
export function toolGateway(registry, ctx, { maxCalls = 16, timeoutMs = 15_000, retries = 1, sleep } = {}) {
  const used = new Map();
  let total = 0;
  const allowed = (tool) => !tool.scope || tool.scope === "public" || Boolean(ctx[tool.scope]);

  return {
    /** Declarations the model is offered: only the tools this session may use. */
    declarations: () => Object.values(registry).filter(allowed).map((t) => t.declaration),

    /** Runs one call. Resolves to { ok, output?, details?, error?, errorKind?, attempts, latencyMs }; never rejects. */
    async call(name, rawArgs) {
      const started = Date.now();
      const args = rawArgs || {};
      let attempts = 0;
      try {
        const tool = Object.hasOwn(registry, name) ? registry[name] : null;
        if (!tool) throw new ToolError("unknown_tool", `Unknown tool ${name}. Use one of: ${Object.keys(registry).filter((n) => allowed(registry[n])).join(", ")}`);
        if (!allowed(tool)) throw new ToolError("denied", `${name} is only available in ${SCOPE_NEEDS[tool.scope] || "another workspace"}.`);
        const problems = validateArgs(tool.declaration.parameters, args);
        if (problems.length) throw new ToolError("invalid_args", `Invalid arguments: ${problems.join("; ")}.`);
        const count = used.get(name) || 0;
        if (total >= maxCalls || count >= (tool.maxCalls ?? 8))
          throw new ToolError("budget", "Tool budget for this question is used up. Answer with the results you have, and say what you could not check.");
        used.set(name, count + 1);
        total++;
        const { output, audit } = await withRetry(
          () => {
            attempts++;
            return withTimeout(tool.run(args, ctx), tool.timeoutMs ?? timeoutMs);
          },
          { retries, sleep },
        );
        return { ok: true, output, details: audit, attempts, latencyMs: Date.now() - started };
      } catch (e) {
        const errorKind = e instanceof ToolError ? e.kind : isTransient(e) ? "unavailable" : "failed";
        return { ok: false, error: String(e?.message || e), errorKind, attempts, latencyMs: Date.now() - started };
      }
    },
  };
}
