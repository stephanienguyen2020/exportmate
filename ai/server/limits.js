// Request-size and scan-frequency limits. Pure or stream-only, so they can be tested alone.

export const MAX_BODY_BYTES = 100_000;
export const SCAN_COOLDOWN_MS = 10 * 60_000;

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

/**
 * Whether a scan may start, given the shared lock document ({ startedAt, running }).
 * Scheduled scans only wait for one that is still running; manual ones also wait out the
 * cooldown after any scan. Returns null to go ahead, or [status, message].
 */
export function scanBlocked(lock, { scheduled, now = Date.now(), cooldownMs = SCAN_COOLDOWN_MS }) {
  const started = lock?.startedAt ? Date.parse(lock.startedAt) : 0;
  const recent = now - started < cooldownMs;
  if (!recent) return null; // also frees a lock left "running" by a crashed scan
  if (lock.running) return [scheduled ? 409 : 429, "A scan is already running."];
  if (!scheduled) return [429, "A scan ran in the last 10 minutes."];
  return null;
}
