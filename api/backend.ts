import type { IncomingMessage, ServerResponse } from "node:http";

// Keep the private-service routing configuration out of the browser bundle.
// Vercel routes /api/v1/* here before the separate AI service rewrite.
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  const fail = (status: number, message: string) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ error: { code: "backend_unavailable", message } }),
    );
  };
  if (!process.env.BACKEND_URL) {
    fail(
      503,
      "The company backend is not configured on this deployment yet. Please try again after setup is complete.",
    );
    return;
  }
  try {
    const incoming = new URL(req.url || "/", "http://localhost");
    const path = incoming.searchParams.get("path") || "";
    incoming.searchParams.delete("path");
    const base = new URL(process.env.BACKEND_URL);
    if (base.protocol !== "https:") throw new Error("Backend requires HTTPS");
    // Append to the fixed upstream origin; never resolve a caller-controlled URL.
    base.pathname =
      "/api/v1/" + path.split("/").map(encodeURIComponent).join("/");
    base.search = incoming.searchParams.toString();
    const headers = new Headers();
    for (const name of ["authorization", "content-type", "x-request-id"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 5 * 1024 * 1024 + 65536) {
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
  } catch {
    fail(502, "The company backend could not be reached. Please try again.");
  }
}
