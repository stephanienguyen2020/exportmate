#!/usr/bin/env bash
# Run the whole ExportMate stack locally with one command:
#   Postgres (Docker, DB_PORT in backend/.env) -> backend API (:8000) -> AI service (:8080) -> frontend (:5173)
#
# Usage:  ./dev.sh        Ctrl+C stops everything except Postgres, which keeps its data.
#         Stop Postgres too: docker compose -f backend/docker-compose.yml down
#
# Sign-in uses dev tokens, not Firebase: log in as lan@example.com with any 8+ character password.
# The AI service reads the real exportmate-app Firestore: run `gcloud auth application-default login` once.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEMO_EMAIL="lan@example.com"
SERVICES=""  # "tag:pid" pairs, watched until one exits

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Stop a process and everything it spawned (npm -> vite, uvicorn -> reload worker, node --watch -> app).
kill_tree() {
  local child
  for child in $(pgrep -P "$1" || true); do kill_tree "$child"; done
  kill "$1" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$SERVICES" ]; then
    say "Stopping services"
    local child
    for child in $(pgrep -P $$ || true); do kill_tree "$child"; done
    wait 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# start <tag> <color> <dir> <command...>: run a service in the background with prefixed output.
start() {
  local tag=$1 color=$2 dir=$3
  shift 3
  local prefix
  prefix="$(printf '\033[%sm%-4s|\033[0m ' "$color" "$tag")"
  (cd "$dir" && exec "$@") 2>&1 | awk -v prefix="$prefix" '{ print prefix $0; fflush() }' &
  SERVICES="$SERVICES $tag:$!"
}

wait_for_url() {
  local name=$1 url=$2 i
  for i in $(seq 1 60); do
    curl -sf -o /dev/null "$url" && return 0
    sleep 1
  done
  die "$name did not respond at $url within 60s (see its log lines above)"
}

# Install only when package-lock.json changed since the last install. `npm ci` never rewrites
# the lockfile, so differing local npm versions don't create lockfile churn.
install_node_deps() {
  local dir=$1
  if [ ! "$dir/node_modules/.package-lock.json" -nt "$dir/package-lock.json" ]; then
    say "Installing npm packages in $dir"
    (cd "$dir" && npm ci --no-audit --no-fund)
    touch "$dir/node_modules/.package-lock.json"
  fi
}

# --- Preflight: fail now with a clear message instead of a confusing error later.
for port in 5173 8000 8080; do
  pid="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [ -z "$pid" ] || die "port $port is already used by PID $pid ($(ps -o command= -p "$pid" | cut -c1-70)). Stop it first: kill $pid"
done
command -v uv >/dev/null || die "uv is not installed: https://docs.astral.sh/uv/getting-started/installation/"
docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker Desktop and try again."
[ -f "${GOOGLE_APPLICATION_CREDENTIALS:-$HOME/.config/gcloud/application_default_credentials.json}" ] ||
  echo "warning: no Google credentials found, so AI chat and news will fail. Run: gcloud auth application-default login"

install_node_deps "$ROOT"
install_node_deps "$ROOT/ai/server"

# --- Database: start Postgres, migrate, load the demo company (seeding twice changes nothing).
cd "$ROOT/backend"
[ -f .env ] || { cp .env.example .env; say "Created backend/.env from .env.example"; }
export AUTH_MODE=dev ENV=development PYTHONUNBUFFERED=1

say "Starting Postgres"
docker compose up -d db ||
  die "Postgres did not start. If its port is taken, change DB_PORT and the ports in DATABASE_URL and TEST_DATABASE_URL in backend/.env"
# Check over TCP: during first-time init Postgres only listens on its socket.
for i in $(seq 1 60); do
  docker compose exec -T db pg_isready -q -h 127.0.0.1 -U exportmate -d exportmate && break
  [ "$i" -lt 60 ] || die "Postgres did not become ready within 60s: docker compose -f backend/docker-compose.yml logs db"
  sleep 1
done

say "Migrating and seeding the database"
uv sync --quiet
uv run alembic upgrade head
uv run python -m app.seed_demo_data --email "$DEMO_EMAIL"

# --- Services
say "Starting services"
start api 36 "$ROOT/backend" uv run uvicorn app.main:app --reload --port 8000
start ai 35 "$ROOT/ai/server" npm run dev
start web 32 "$ROOT" env VITE_AUTH_MODE=dev npm run dev

wait_for_url "Backend" "http://127.0.0.1:8000/api/v1/health"
wait_for_url "Frontend" "http://127.0.0.1:5173/"

printf '\n\033[1mExportMate is running\033[0m\n'
printf '  App         http://127.0.0.1:5173/#/login   (%s, any password of 8+ characters)\n' "$DEMO_EMAIL"
printf '  API docs    http://127.0.0.1:8000/api/v1/docs\n'
printf '  AI service  http://127.0.0.1:8080\n'
printf 'Press Ctrl+C to stop.\n\n'

# If any service exits, stop the rest rather than leave a half-working stack.
while sleep 2; do
  for service in $SERVICES; do
    kill -0 "${service#*:}" 2>/dev/null || die "${service%%:*} stopped (see its log lines above); shutting down"
  done
done
