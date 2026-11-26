// Request-size limits. Stream-only, so they can be tested alone.

export const MAX_BODY_BYTES = 100_000;

/**
 * Reads a JSON request body. Past `maxBytes` it stops keeping data (the rest is drained,
 * not buffered) and rejects with status 413.
 */
export function readJson(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) return chunks.push(chunk);
      req.off("data", onData);
      req.resume(); // discard the rest
      fail(Object.assign(new Error("Request body too large"), { status: 413 }));
    };
    req.on("data", onData);
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(Object.assign(e, { status: 400 }));
      }
    });
    req.on("error", fail);
  });
}

