# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ExportMate: a trade-compliance prototype for small manufacturers (demo persona: a Vietnamese wood-products/furniture exporter). Three independently built parts:

- **Frontend** (repo root): React 19 + TypeScript + Vite SPA, deployed to Vercel (exportmate.vercel.app).
- **Backend** (`backend/`): Python FastAPI + Postgres (Cloud SQL), Firebase Auth tokens, routes under `/api/v1`. Being built in phases; see `backend/REQUIREMENTS.md` (scope, decisions, phases, open questions) and `backend/README.md` (commands, layout).
- **AI service** (`ai/server/`): a plain-JS Node ≥20 HTTP service (no framework, no build step) on Google Cloud Run that serves every `/api/*` route, backed by Firestore and Gemini on Vertex AI.

## Commands

Frontend (repo root):

```sh
npm install
npm run dev       # Vite on http://127.0.0.1:5173, proxies /api to 127.0.0.1:8080
npm run build     # tsc -b type-check + vite build to dist/ — this is the only "check"; there is no lint or test suite
npm run preview
```

AI service (`ai/server/`, needs `gcloud auth application-default login`; talks to the real `exportmate-app` Firestore):

```sh
npm run dev       # node --watch on :8080
npm run seed      # upsert synthetic inventory + default news sources, then rebuild the vector index
npm run scan      # run one news scan now (--lookback=14 to re-read two weeks)
npm run index     # rebuild the vector index; `node rag.js "<query>"` runs a test search
gcloud run deploy exportmate-ai --source . --region asia-southeast1 --project exportmate-app
```

Verification so far has been manual: production build plus headless-Chrome checks at multiple widths (see `docs/VALIDATION.md` for the flows that have been exercised).

Backend (`backend/`, uses uv; Postgres via `docker compose up -d` on :5433):

```sh
uv run alembic upgrade head
uv run python -m app.seed_demo_data --email lan@example.com
uv run uvicorn app.main:app --reload --port 8000   # docs at /api/v1/docs
uv run pytest                                      # needs Postgres (TEST_DATABASE_URL)
uv run pytest tests/test_imports.py -k commit      # single test
uv run ruff check . && uv run ruff format .
```

Locally `AUTH_MODE=dev` accepts `Authorization: Bearer dev:<email>` instead of a Firebase token.

## Architecture

### Backend layering (`backend/app/`)

- `api/` routers do HTTP only; `services/` hold business logic and own `db.commit()`; `database/queries/` is the only place that builds SQL (never commits); `database/models/` holds tables; `schemas/` are pydantic models (camelCase JSON); `core/` has config, auth, errors.
- Company scoping: routes take `ViewerContext`/`EditorContext`/`OwnerContext` (from `core/auth.py`); the company comes from the caller's Postgres membership, never the request. Other companies' records return 404.
- Money is integer minor units + currency (`valueMinor`). Orders from CSV import start as `awaiting_analysis`; the import keeps the original file and each row (`import_rows`) so later reports can cite them.
- Style the user asked for: all imports at the top of the file, and specific names (`success_response`, `get_order_by_external_id`), not generic ones (`ok`, `get`).

### Frontend routing and state

- Hash-based routing, no router library. `src/main.tsx` holds `Root` (public pages, account flows, session gate that redirects to `#/login` and remembers the target) and `App` (the workspace under `#/workspace/...`; the route string has the `workspace/` prefix stripped and views are selected with `route === "orders"` etc.). Most workspace views live inline in `main.tsx`.
- `src/Landing.tsx` is the public landing (`#/`); `src/TradeGlobe.tsx` is a Three.js globe that is lazy-loaded into its own chunk (Vite's 500 kB chunk warning for it is expected).
- `src/Account.tsx` + `src/account-store.ts`: login/signup/onboarding/reset are **preview flows only** — no real auth, nothing sent, no passwords stored.
- Orders, playbook rules, profile, and demo state persist in browser storage only (localStorage: `em-orders`, `em-rules`, `em-sent`, `em-profile`, `em-inquiry`; sessionStorage: `em-session`, `em-next`; chat session id: `em-chat-session`). Seed data is in `src/data.ts`. The AI service cannot see orders or rules.
- The "five-agent review" / rule-change demo in the workspace is simulated client-side; it is unrelated to the real agent in `ai/server`.

### AI code (`ai/`)

- `ai/chat/` and `ai/news/` are frontend TSX modules imported by `src/main.tsx` (and included in `tsconfig.json`), not a separate app. `ai/chat/agent-client.ts` defines the shared API types (`Audit`, `AuditStep`, `Citation`) and the base URL (`VITE_CHAT_API_URL`, default `/api`).
- `ai/server/index.js`: raw `http` server with manual route dispatch (`/api/chat` streams NDJSON; also `/api/audits`, `/api/inventory`, `/api/impacts`, `/api/scan`, `/api/sources`). Config via env: `PORT`, `GEMINI_MODEL`, `EMBED_MODEL`, `ALLOWED_ORIGINS`, `SCHEDULER_SA`, `SCAN_AUDIENCE`, `GOOGLE_CLOUD_PROJECT`.
- `agent.js`: Gemini tool-calling loop (max steps bounded) with tools `search_knowledge`, `query_inventory`, `get_alerts`, `calculate`, `get_scan_status`. Every fact must carry a numbered citation; a `review` (auditor) step checks citations resolve to retrieved evidence and figures appear in tool results, sending a failing draft back to the model once. Each answer streams steps live and is stored as an audit record in the `audits` collection. When changing tools or step shapes, keep `AuditStep` in `agent-client.ts` and the `Audit.tsx` renderer in sync.
- `rag.js`: Firestore vector search over `gemini-embedding-001` (768-dim, cosine) in the `kb` collection, indexing stock items, articles, alerts, sources and help guides (`seed/guides.js`).
- `scan.js` + `feeds.js`: news scan — reads enabled RSS/Atom sources, skips already-analysed articles, asks Gemini which SKUs each article affects, writes `impacts` and indexes new articles/alerts. Triggered daily by Cloud Scheduler (OIDC-signed `POST /api/scan`, which bypasses the 10-minute "Scan now" rate limit). User-added feeds must be public HTTPS; private/metadata addresses are blocked.
- `db.js`: Firestore client and collection handles (`inventory`, `sources`, `articles`, `impacts`, `scans`). The `kb` and `audits` collections are accessed from `rag.js` and the agent/server code.

### Deployment wiring

- `vercel.json` rewrites `/api/*` to the Cloud Run URL; locally `vite.config.ts` proxies `/api` to `:8080`.
- `.vercelignore` excludes `ai/server` and `docs` from the Vercel upload; `ai/server/.gcloudignore` governs the Cloud Run source deploy.

## Docs

Planning docs in `docs/` (`FRONTEND_PLAN.md`, `ACCOUNT_AND_SITE_PLAN.md`, `LANDING_DESIGN.md`, `BACKEND_PLAN.md`) describe intended designs; much of `BACKEND_PLAN.md` (real auth, durable server storage, notification delivery, document extraction) is not implemented. All legal/regulatory content is illustrative; inventory is synthetic, news is real.
