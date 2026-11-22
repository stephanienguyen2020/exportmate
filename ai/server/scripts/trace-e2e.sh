#!/usr/bin/env bash
# End-to-end check of the assistant's routing, logging and tracing, run on this machine against
# real Gemini, Firestore and Cloud Trace (project skilful-scarab-511320-q9). Nothing deployed changes.
#
#   browser → Vite :5174 → fake front end :8095 (adds X-Cloud-Trace-Context, as Cloud Run does)
#           → AI service index.js :8090 → agent runtime runtime.js :8091 → Gemini, Firestore
#                                         └─ ADK spans → Cloud Trace, service "local-trace-test"
#
# Usage (from anywhere in the repo):
#   ai/server/scripts/trace-e2e.sh up                 start everything; Ctrl+C stops it
#   ai/server/scripts/trace-e2e.sh up --broken-model  same, with the complex tier on a model that
#                                                     doesn't exist, to see a failure in logs and trace
#   ai/server/scripts/trace-e2e.sh check              in a second terminal, after some chats: one row
#                                                     per chat (tier, model, status, trace) and whether
#                                                     its agent spans sit under the request in Cloud Trace
#
# Needs: Node >= 22.18, gcloud signed in (`gcloud auth login` and `gcloud auth application-default login`)
# with access to the project. Demo chats write their audits to the project's Firestore, as on the live site.
set -euo pipefail

PROJECT=skilful-scarab-511320-q9
BACKEND=https://exportmate-backend-3v6cd2xhpq-as.a.run.app
SERVER="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$SERVER/../.." && pwd)"
WORK="$SERVER/.e2e"
LOGS="$WORK/logs"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Node >= 22.18 (the frontend's tests and Vite need it); prefer Homebrew's when the default is older.
pick_node() {
  local v
  for dir in "$(dirname "$(command -v node 2>/dev/null || echo /nonexistent)")" /opt/homebrew/bin /usr/local/bin; do
    [ -x "$dir/node" ] || continue
    v="$("$dir/node" -p 'const [a,b]=process.versions.node.split(".").map(Number); a>22||(a===22&&b>=18)?1:0')"
    if [ "$v" = 1 ]; then PATH="$dir:$PATH"; export PATH; return; fi
  done
  die "Node 22.18 or newer is needed (node -v shows $(node -v 2>/dev/null || echo none))"
}

write_harness() {
  mkdir -p "$LOGS"
  # The runtime, with ADK's spans exported the way agents/telemetry.js does on Agent Runtime, but
  # under a made-up instance name so they don't mix with the live instance's Traces tab.
  cat >"$SERVER/.e2e-runtime.mjs" <<'EOF'
import { maybeSetOtelProviders } from "@google/adk";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { GoogleAuth } from "google-auth-library";
import { PROJECT } from "./db.js";
import { traceResource } from "./agents/telemetry.js";

process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS = "false";
const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
const exporter = new OTLPTraceExporter({
  url: "https://telemetry.googleapis.com/v1/traces",
  headers: async () => ({ Authorization: `Bearer ${await auth.getAccessToken()}`, "x-goog-user-project": PROJECT }),
});
const resource = { ...traceResource({ project: PROJECT, location: "asia-southeast1", id: "local-trace-test" }), "service.name": "local-trace-test" };
maybeSetOtelProviders([{ spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 1000 })] }], resourceFromAttributes(resource));
const { server } = await import("./runtime.js");
server.listen(8091, "127.0.0.1", () => console.log(JSON.stringify({ severity: "INFO", message: "e2e.runtime_ready", complexModel: process.env.GEMINI_MODEL_COMPLEX || "default" })));
EOF
  # Stands in for Cloud Run's front end: adds X-Cloud-Trace-Context and records each chat's trace.
  cat >"$SERVER/.e2e-gfe.mjs" <<'EOF'
import http from "node:http";
import { randomBytes } from "node:crypto";
http
  .createServer((req, res) => {
    const traceId = randomBytes(16).toString("hex");
    const span = BigInt("0x" + randomBytes(8).toString("hex")) & 0x7fffffffffffffffn;
    const headers = { ...req.headers, "x-cloud-trace-context": `${traceId}/${span};o=1` };
    if (req.url.startsWith("/api/chat")) console.log(JSON.stringify({ message: "e2e.request", at: new Date().toISOString(), traceId, spanId: String(span) }));
    const up = http.request({ host: "127.0.0.1", port: 8090, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", (e) => (res.writeHead(502), res.end(String(e))));
    req.pipe(up);
  })
  .listen(8095, "127.0.0.1", () => console.log(JSON.stringify({ message: "e2e.gfe_ready" })));
EOF
}

# Stop a process and everything it spawned (npx → vite, node --watch → app), as dev.sh does.
kill_tree() {
  local child
  for child in $(pgrep -P "$1" || true); do kill_tree "$child"; done
  kill "$1" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  say "Stopping"
  local child
  for child in $(pgrep -P $$ || true); do kill_tree "$child"; done
  wait 2>/dev/null || true
  rm -f "$SERVER/.e2e-runtime.mjs" "$SERVER/.e2e-gfe.mjs"
}

wait_for() {
  local name=$1 url=$2 i
  for i in $(seq 1 60); do curl -s -o /dev/null -m 2 "$url" && return 0; sleep 1; done
  die "$name did not start; see $LOGS/$name.log"
}

up() {
  local broken=""
  [ "${1:-}" = "--broken-model" ] && broken=gemini-does-not-exist
  pick_node
  for port in 5174 8090 8091 8095; do
    pid="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
    [ -z "$pid" ] || die "port $port is in use by PID $pid ($(ps -o command= -p "$pid" | cut -c1-60))"
  done
  [ -f "$HOME/.config/gcloud/application_default_credentials.json" ] || [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ] ||
    die "no Google credentials: run gcloud auth application-default login"
  for dir in "$SERVER" "$ROOT/frontend"; do
    [ -d "$dir/node_modules" ] || { say "Installing npm packages in ${dir#$ROOT/}"; (cd "$dir" && npm ci --no-audit --no-fund >/dev/null); }
  done
  write_harness
  : >"$LOGS/runtime.log"; : >"$LOGS/ai.log"; : >"$LOGS/gfe.log"; : >"$LOGS/web.log"
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  local common=(PROJECT_ID=$PROJECT GOOGLE_CLOUD_PROJECT=$PROJECT BACKEND_URL=$BACKEND K_SERVICE=local)
  say "Starting the agent runtime (:8091)${broken:+ with the complex tier on $broken}"
  (cd "$SERVER" && env "${common[@]}" GEMINI_LOCATION=global GEMINI_THINKING_COMPLEX=LOW RAG_BUCKET=$PROJECT-kb \
    ${broken:+GEMINI_MODEL_COMPLEX=$broken} node .e2e-runtime.mjs >>"$LOGS/runtime.log" 2>&1) &
  say "Starting the AI service (:8090)"
  (cd "$SERVER" && env "${common[@]}" PORT=8090 AGENTS_AT=http://127.0.0.1:8091 \
    ALLOWED_ORIGINS=http://127.0.0.1:5174,http://localhost:5174 node index.js >>"$LOGS/ai.log" 2>&1) &
  say "Starting the fake front end (:8095)"
  (cd "$SERVER" && node .e2e-gfe.mjs >>"$LOGS/gfe.log" 2>&1) &
  say "Starting the website (:5174)"
  (cd "$ROOT/frontend" && AI_SERVICE_URL=http://127.0.0.1:8095 BACKEND_URL=$BACKEND npx vite --port 5174 --strictPort --host 127.0.0.1 >>"$LOGS/web.log" 2>&1) &

  wait_for runtime http://127.0.0.1:8091/
  wait_for ai http://127.0.0.1:8090/
  wait_for gfe http://127.0.0.1:8095/
  wait_for web http://127.0.0.1:5174/

  cat <<EOF

$(printf '\033[1mReady.\033[0m') Open http://127.0.0.1:5174/ → "Explore demo" → the chat button (bottom right).
Questions to try (new chats and follow-ups in the same chat):
  Which orders need action, and why?                     standard → gemini-3.5-flash
  Which of those two ships first?   (same chat)           standard → gemini-3.5-flash
  What is the combined stock value of PLY-101 and PLY-102, and the average of the two?
                                                         complex  → gemini-4-argon (may 429)
  How do I import my orders?                             simple   → gemini-3.5-flash-lite
  Tôi cần những giấy tờ gì để xuất khẩu gỗ dán sang EU?   simple, escalated → gemini-3.5-flash if sent back
Then, in another terminal:  ai/server/scripts/trace-e2e.sh check
Logs: ${LOGS#$ROOT/}/  (ai.log = the AI service, runtime.log = the agents). Ctrl+C stops everything.

EOF
  while sleep 2; do
    for job in $(jobs -p); do kill -0 "$job" 2>/dev/null || die "a service stopped; see $LOGS/*.log"; done
  done
}

check() {
  [ -s "$LOGS/gfe.log" ] || die "no chats yet: run '$0 up' and ask something in the browser first"
  command -v jq >/dev/null || die "jq is needed (brew install jq)"
  local token; token="$(gcloud auth print-access-token)"
  say "Chats (newest last). 'joined' = the agents' invocation span is a child of the request's span"
  printf '%-8s  %-9s %-22s %-6s %-9s %-7s %-8s %s\n' TRACE TIER MODEL STATUS LATENCY SPANS JOINED "MODEL CALLS IN TRACE"
  # Each chat request from the fake front end, matched by trace ID to the AI service's log line.
  jq -r 'select(.message=="e2e.request") | "\(.traceId) \(.spanId)"' "$LOGS/gfe.log" | while read -r trace span; do
    local line tier model status latency
    line="$(grep -F "traces/$trace" "$LOGS/ai.log" | grep -E '"chat\.(completed|agents_error)"' | tail -1 || true)"
    [ -n "$line" ] || continue  # an OPTIONS preflight or a chat still running
    tier="$(jq -r '.tier // "-"' <<<"$line")"
    model="$(jq -r '.model // "-"' <<<"$line")"
    status="$(jq -r 'if .message=="chat.agents_error" then "error \(.errorStatus // "")" else .status end' <<<"$line")"
    latency="$(jq -r 'if .latencyMs then "\(.latencyMs/1000|floor)s" else "-" end' <<<"$line")"
    local spans joined calls t
    t="$(curl -s -H "Authorization: Bearer $token" "https://cloudtrace.googleapis.com/v1/projects/$PROJECT/traces/$trace")"
    spans="$(jq '.spans | length? // 0' <<<"$t")"
    joined="$(jq -r --arg s "$span" 'if ([.spans[]? | select(.name=="invocation" and .parentSpanId==$s)] | length) > 0 then "yes" else "not yet" end' <<<"$t")"
    calls="$(jq -r '[.spans[]? | select(.name=="call_llm") | (.labels["gen_ai.request.model"] // "?") + (if .labels["error.type"] then " ✗" + .labels["error.type"] else "" end)] | group_by(.) | map("\(.[0])×\(length)") | join(", ")' <<<"$t")"
    printf '%-8s  %-9s %-22s %-6s %-9s %-7s %-8s %s\n' "${trace:0:8}" "$tier" "$model" "${status:0:6}" "$latency" "$spans" "$joined" "$calls"
  done
  echo
  say "Errors the agents logged (each carries its chat's trace)"
  for f in ai runtime; do
    grep -E '^\{.*"severity":"ERROR"' "$LOGS/$f.log" 2>/dev/null |
      jq -r --arg f "$f" '"\($f): \(.message) status=\(.status // .errorStatus // "-") trace=\(.["logging.googleapis.com/trace"] // "-" | split("/")[-1][0:8]) \(.error // "" | .[0:90])"' || true
  done
  cat <<EOF

Spans arrive a few seconds after a chat ends, the agents' top span last: if a chat just finished
shows "not yet", run check again. If it still says "not yet" a minute later, the trace isn't joined.
Open a chat in the console:  https://console.cloud.google.com/traces/explorer;traceId=<full trace id>?project=$PROJECT
EOF
}

case "${1:-}" in
  up) shift; up "$@" ;;
  check) check ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
