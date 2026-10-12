import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

// One JSON line per event in the Vercel function logs. Never logs headers,
// bodies or query strings: they can hold tokens and personal data.
function logEvent(
  level: "info" | "warn" | "error",
  message: string,
  fields: Record<string, unknown>,
) {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

// Keep the private-service routing configuration out of the browser bundle.
// Vercel routes /api/v1/* here before the separate AI service rewrite.
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  const started = Date.now();
  // Forwarded to the backend, which tags its own log lines and error bodies with it.
  const header = req.headers["x-request-id"];
  const requestId =
    (typeof header === "string" && header.slice(0, 64)) || randomUUID().replace(/-/g, "");
  let path = "";
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Request-ID", requestId);
  const fail = (status: number, message: string) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: { code: "backend_unavailable", message, requestId },
      }),
    );
  };
  if (!process.env.BACKEND_URL) {
    logEvent("error", "proxy.not_configured", { requestId });
    fail(
      503,
      "The company backend is not configured on this deployment yet. Please try again after setup is complete.",
    );
    return;
  }
  try {
    const incoming = new URL(req.url || "/", "http://localhost");
    path = incoming.searchParams.get("path") || "";
    incoming.searchParams.delete("path");
    const base = new URL(process.env.BACKEND_URL);
    if (base.protocol !== "https:") throw new Error("Backend requires HTTPS");
    // Append to the fixed upstream origin; never resolve a caller-controlled URL.
    base.pathname =
      "/api/v1/" + path.split("/").map(encodeURIComponent).join("/");
    base.search = incoming.searchParams.toString();
    const headers = new Headers();
    for (const name of ["authorization", "content-type"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    headers.set("x-request-id", requestId);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 5 * 1024 * 1024 + 65536) {
        logEvent("warn", "proxy.body_too_large", { requestId, path, size });
        fail(413, "File must be smaller than 5 MB.");
        return;
      }
      chunks.push(buffer);
    }
    const response = await fetch(base, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
      signal: AbortSignal.timeout(25000),
      redirect: "error",
    });
    res.statusCode = response.status;
    for (const name of ["content-type", "x-request-id"]) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.end(Buffer.from(await response.arrayBuffer()));
    logEvent(response.status >= 500 ? "error" : "info", "proxy.completed", {
      requestId,
      method: req.method,
      path: `/api/v1/${path}`,
      status: response.status,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    logEvent("error", "proxy.upstream_failed", {
      requestId,
      method: req.method,
      path: `/api/v1/${path}`,
      // Server-side function log only (timeout vs network vs config); the caller
      // gets the generic message below.
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      durationMs: Date.now() - started,
    });
    fail(502, "The company backend could not be reached. Please try again.");
  }
}
