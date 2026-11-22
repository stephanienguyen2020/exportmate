import { test } from "node:test";
import assert from "node:assert/strict";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

// On Agent Runtime, ADK's NodeTracerProvider registers this context manager (agents/telemetry.js).
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
// JSON log lines, as on Cloud Run and Agent Runtime.
process.env.K_SERVICE = "test";
const { inRequestTrace, log, traceparentFrom } = await import("../log.js");
const { PROJECT } = await import("../db.js");

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

/** The JSON lines `fn` logs. */
async function logged(fn) {
  const lines = [];
  const { log: out, error: err } = console;
  console.log = console.error = (line) => lines.push(JSON.parse(line));
  try {
    await fn();
  } finally {
    Object.assign(console, { log: out, error: err });
  }
  return lines;
}

test("the request's trace for the agents: from X-Cloud-Trace-Context, else traceparent, always sampled", () => {
  // Cloud Run's header: span in decimal, sampling flag that may be off.
  assert.equal(traceparentFrom({ "x-cloud-trace-context": `${TRACE.toUpperCase()}/1234567890123;o=0` }), `00-${TRACE}-0000011f71fb04cb-01`);
  assert.equal(traceparentFrom({ traceparent: `00-${TRACE}-00f067aa0ba902b7-00` }), `00-${TRACE}-00f067aa0ba902b7-01`);
  // Both present: the one this service's own log lines use.
  assert.equal(traceparentFrom({ "x-cloud-trace-context": `${TRACE}/1`, traceparent: `00-${"a".repeat(32)}-00f067aa0ba902b7-01` }), `00-${TRACE}-0000000000000001-01`);
  for (const headers of [{}, { "x-cloud-trace-context": "nonsense" }, { traceparent: "00-zz-yy-01" }, { "x-cloud-trace-context": `${"0".repeat(32)}/1` }, { "x-cloud-trace-context": `${TRACE}/0` }])
    assert.equal(traceparentFrom(headers), undefined, JSON.stringify(headers));
});

test("a turn run in the request's trace logs into that trace, across awaits", async () => {
  const lines = await logged(() =>
    inRequestTrace(`00-${TRACE}-00f067aa0ba902b7-01`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      log("ERROR", "agent.failed", { requestId: "r1", status: 429 });
    }),
  );
  assert.deepEqual(lines, [{ severity: "ERROR", message: "agent.failed", requestId: "r1", status: 429, "logging.googleapis.com/trace": `projects/${PROJECT}/traces/${TRACE}` }]);
});

test("spans started in the turn (ADK's invocation, agent, model and tool spans) are children of the request's span", async () => {
  const exporter = new InMemorySpanExporter();
  const tracer = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).getTracer("gcp.vertex.agent");
  await inRequestTrace(`00-${TRACE}-00f067aa0ba902b7-00`, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    tracer.startActiveSpan("invocation", (span) => span.end());
  });
  const [span] = exporter.getFinishedSpans();
  assert.equal(span.spanContext().traceId, TRACE);
  assert.equal(span.parentSpanContext?.spanId, "00f067aa0ba902b7");
  // Sampled even when the load balancer's flag said not to: the agents' spans are kept.
  assert.equal(span.spanContext().traceFlags, 1);
});

test("without a trace the turn runs as before, and an explicit header still wins", async () => {
  const [plain] = await logged(() => inRequestTrace(undefined, async () => log("INFO", "chat.completed")));
  assert.equal(plain["logging.googleapis.com/trace"], undefined);
  const [explicit] = await logged(() => inRequestTrace(`00-${TRACE}-00f067aa0ba902b7-01`, async () => log("INFO", "x", { trace: `${"b".repeat(32)}/1` })));
  assert.equal(explicit["logging.googleapis.com/trace"], `projects/${PROJECT}/traces/${"b".repeat(32)}`);
  assert.equal(await inRequestTrace("garbage", async () => "ran"), "ran");
});
