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
npm run build     # tsc -b type-check + vite build to dist/ (no frontend linter)
npm test          # Vercel proxy test (node --test, Node 22.18+) + Playwright browser tests against mocked APIs
npx playwright test -g "news sources"   # single Playwright test; `npx playwright install chromium` once first
npm run preview
```

AI service (`ai/server/`, needs `gcloud auth application-default login`; talks to the real Firestore of `GOOGLE_CLOUD_PROJECT`, default `exportmate-app` until the move to `skilful-scarab-511320-q9` in `infra/terraform/README.md` is finished):

```sh
npm run dev       # node --watch on :8080
npm run seed      # upsert synthetic inventory + default news sources, then rebuild the vector index
npm run scan      # run one news scan now (--lookback=14 to re-read two weeks)
npm run index     # rebuild the vector index; `node rag.js "<query>"` runs a test search
npm test          # harness unit tests (no GCP needed)
npm run eval      # golden-set eval against live Gemini + Firestore (--only=<ids>, --judge); exits 1 on regressions
npm run ops       # health summary of recent chat audits (--days=1, --json)
PROJECT_ID=skilful-scarab-511320-q9 ./deploy.sh   # Cloud Build image -> Cloud Run service + job (infra in infra/terraform/ai_service.tf)
gcloud run jobs execute exportmate-ai-task --region asia-southeast1 --wait --args="node eval/run.js"   # any npm script's command, on GCP
```

CI (`.github/workflows/ci.yml`, on pushes to main and on PRs) runs the frontend build and `npm test`, backend ruff + `alembic check` + pytest against Postgres, and a parse check plus the unit tests of `ai/server` (the golden-set eval needs GCP and runs by hand). Beyond that, verification is manual headless-Chrome checks at multiple widths; `docs/VALIDATION.md` records the flows that have been exercised.

Backend (`backend/`, uses uv; Postgres via `docker compose up -d` on :5433):

```sh
uv run alembic upgrade head
uv run python -m app.seed_demo_data --email lan@example.com
uv run python -m app.cleanup_imports --older-than-days 30   # delete uploads never committed
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
- Money is an integer number of hundredths of the currency unit + an ISO 4217 currency (`valueMinor`; also ×100 for JPY/VND, so readers always divide by 100). Orders from CSV import start as `awaiting_analysis`; the import keeps the original file and each row (`import_rows`) so later reports can cite them. Uploads are capped at 4 MB (Vercel's function body limit) and 60 per user per hour (`core/rate_limit.py`, in memory per instance).
- Style the user asked for: all imports at the top of the file, and specific names (`success_response`, `get_order_by_external_id`), not generic ones (`ok`, `get`).
- Relational data belongs in Postgres (Cloud SQL in production), not hard-coded in the frontend. Trade map: shared reference tables (`markets`, `countries`, `ports`, `document_kinds`, `market_requirements`, `satellite_observations`) and company tables (`suppliers`, `supplier_documents`, `company_sites`); orders match suppliers by `name_key` (trimmed, lower-case). `services/trade_map.py` places destinations, checks documents per market and compares markets. Seed data lives in `app/seed_data/*.json`: `python -m app.seed_reference_data` (run by `deploy.sh` after migrations) and `seed_demo_data` (demo company's suppliers/sites). Checklists are illustrative; observations are samples.
- Logging (`core/logging.py`): every line carries the request ID; one `request.completed` line per request with user/company IDs; services log what they changed with `extra={...}`. JSON in production for Cloud Logging. Never log tokens, emails or file contents.

### Frontend routing and state

- Hash-based routing, no router library. `src/main.tsx` holds `Root` (public pages, account flows, session gate that redirects to `#/login` and remembers the target) and `App` (the workspace under `#/workspace/...`; the route string has the `workspace/` prefix stripped and views are selected with `route === "orders"` etc.). Most workspace views live inline in `main.tsx`.
- `src/Landing.tsx` is the public landing (`#/`); `src/TradeGlobe.tsx` is a Three.js globe that is lazy-loaded into its own chunk (Vite's 500 kB chunk warning for it is expected). The Firebase SDK and PapaParse are also loaded on demand, keeping the main chunk under 500 kB.
- Trade map (`#/workspace/map`, deep links `map/order/<id>`, `map/market/<code>`, `map/supplier/<name>`): `src/TradeMap.tsx` is lazy-loaded and draws world-atlas outlines with d3-geo (110m for the world view, 50m fetched on demand for zoomed views); markers are HTML buttons over the SVG. All map data comes from the backend (`GET /api/v1/trade-map`, `GET /api/v1/trade-map/compare`), so the map only works in a connected session; the browser-only demo shows a sign-in prompt instead. Only map geometry (projections, camera presets, label placement) lives in the frontend.
- `src/Account.tsx` + `src/account-store.ts` + `src/auth.ts`: sign-up, sign-in, email verification and password reset use Firebase Auth (SDK loaded on first use). With `VITE_AUTH_MODE=dev` the Vite dev server accepts any password and sends `dev:<email>` tokens. "Explore the demo" opens the browser-only sample workspace with no account. After sign-in (or the demo), `intendedRoute()` returns to the workspace page that sent the visitor to `#/login`.
- Two kinds of session (`em-session` in sessionStorage): `demo` keeps orders, playbook rules, profile and demo state in browser storage (localStorage: `em-orders`, `em-rules`, `em-sent`, `em-profile`, `em-inquiry`); `api` reads and writes them through the backend (`src/api.ts`), and `em-profile` is only a cache of `GET /me`. Other sessionStorage keys: `em-next` (page to return to), `em-chat` and `em-chat-session` (chat history and audit session, cleared on sign-out and sign-in). Seed data is in `src/data.ts`; the demo's CSV checks (`src/order-csv.ts`) mirror the backend's. The AI service cannot see orders or rules.
- The "five-agent review" / rule-change demo in the workspace is simulated client-side; it is unrelated to the real agent in `ai/server`.

### AI code (`ai/`)

- `ai/chat/` and `ai/news/` are frontend TSX modules imported by `src/main.tsx` (and included in `tsconfig.json`), not a separate app. `ai/chat/agent-client.ts` defines the shared API types (`Audit`, `AuditStep`, `Citation`) and the base URL (`VITE_CHAT_API_URL`, default `/api`).
- `ai/server/index.js`: raw `http` server with manual route dispatch (`/api/chat` streams NDJSON; also `/api/audits`, `/api/inventory`, `/api/impacts`, `/api/scan`, `/api/sources`). Config via env: `PORT`, `GEMINI_MODEL`, `EMBED_MODEL`, `ALLOWED_ORIGINS`, `SCHEDULER_SA`, `SCAN_AUDIENCE`, `GOOGLE_CLOUD_PROJECT`, `BACKEND_URL` (company backend origin, default `http://127.0.0.1:8000`), `CHAT_LIMIT_PER_CLIENT` / `CHAT_LIMIT_PER_INSTANCE` (chats per hour, default 40 / 200, counted in memory; the client is the first `X-Forwarded-For` address), `SCAN_SCHEDULE` (how the assistant describes the scheduler job). For a chat with a `Bearer` token (signed-in company workspace), `index.js` fetches `GET /api/v1/company/knowledge` with that token and passes the profile to the agent; failures fall back to the anonymous demo chat. News sources (`access.js`): built-in sources are shared by every workspace, and a company can switch one off only for itself (`companySources/{companyId}`); a custom source belongs to the company that added it, and only that company sees it and the articles and alerts it brought in (scan records carry `sourceIds` / `sourceCompanyIds`). Changing sources and starting a manual scan call `GET /api/v1/me` with the caller's token (cached for a minute) and accept only owners and editors (401 signed out, 403 other roles, 503 if the backend can't be reached). Reads take an optional token to apply the company's view. An audit made in a company workspace needs that company's token; the model's raw `thought` stays in Firestore and is never sent to clients. Request bodies over 100 KB get 413 (`limits.js`).
- `agent.js`: Gemini ReAct loop (max 6 steps) over a tool `REGISTRY`: `search_knowledge`, `query_inventory`, `get_alerts`, `calculate`, `get_scan_status`, and `get_company_profile` (scope `company`: only offered and allowed when a company profile was loaded; cited as type `company`; the system prompt then names that company and flags stock/alerts as demo data). All tools are read-only. Every fact must carry a numbered citation. Each answer streams steps live and is stored as an audit record in the `audits` collection (with `policyVersion`, `requestId`, guard `flags`; `status` is `needs_review` when the final answer still fails the auditor). When changing tools or step shapes, keep `AuditStep` in `agent-client.ts` and the `Audit.tsx` renderer in sync. The harness around it (see `docs/AGENT_HARNESS.md`), all pure modules with tests in `test/`:
  - `policy.js`: the system-prompt rules; each names the failure it `prevents`. Add a rule (and a golden case) when a new failure is found; `POLICY_VERSION` is stored on audits.
  - `gateway.js`: every tool call is validated against its declared schema, scope-checked, budgeted per turn, timed out and retried only on transient errors; refusals return an `errorKind`. `withRetry` also wraps Gemini calls.
  - `guard.js`: third-party text (articles, alerts, custom feed names) addressed to the assistant is replaced with `[removed: …]` and flagged; `asData` fences text placed in prompts.
  - `review.js`: the auditor; citations resolve, figures and percentages appear in the user's messages or this turn's tool results, cited news carries its date, links are retrieved sources. A failing draft goes back once.
  - `rerank.js`: BM25 rerank of vector candidates (hybrid retrieval). `calc.js`: the calculator. `metrics.js`: audit aggregates for `ops.js` and the eval. `log.js`: JSON log lines on Cloud Run (one `chat.completed` per answer; never question text or tokens).
  - `eval/`: `golden.js` (cases with expectations computed from the live stock), `score.js` (answer + trajectory scoring), `run.js` (runner, optional LLM judge, regression check; results in the git-ignored `eval/results/`).
- `rag.js`: Firestore vector search over `gemini-embedding-001` (768-dim, cosine) in the `kb` collection, indexing stock items, articles, alerts, sources and help guides (`seed/guides.js`); `search()` fetches 3× candidates and reranks them with `rerank.js`.
- `scan.js` + `feeds.js`: news scan — reads enabled RSS/Atom sources, skips already-analysed articles, asks Gemini which SKUs each article affects, writes `impacts` and indexes new articles/alerts. Article text is fenced in `<article>` tags; articles containing injected instructions are withheld (`articlesWithheld`). Triggered daily by Cloud Scheduler (OIDC-signed `POST /api/scan`, which bypasses the 10-minute cooldown); "Scan now" needs an owner or editor. A `locks/scan` document claimed in a Firestore transaction keeps two scans from running at once. After Gemini, an article that names another commodity but no wood goods is dropped (`relevance.js`). Feeds must be public HTTPS; `feeds.js` checks the address when the socket connects (so DNS rebinding can't reach private or metadata addresses; NAT64/6to4 addresses are judged by the IPv4 inside) and stops reading past 3 MB.
- `db.js`: Firestore client and collection handles (`inventory`, `sources`, `articles`, `impacts`, `scans`). The `kb` and `audits` collections are accessed from `rag.js` and the agent/server code.

### Deployment wiring

- `vercel.json` rewrites `/api/*` to the Cloud Run URL; locally `vite.config.ts` proxies `/api` to `:8080`.
- `.vercelignore` excludes `ai/server` and `docs` from the Vercel upload; `ai/server/.gcloudignore` governs the Cloud Run source deploy.

## Docs

`docs/AGENT_HARNESS.md` maps the AI service's harness (policy, tools, guard, auditor, eval, ops, governance) to code and lists what is not done. Planning docs in `docs/` (`FRONTEND_PLAN.md`, `ACCOUNT_AND_SITE_PLAN.md`, `LANDING_DESIGN.md`, `BACKEND_PLAN.md`) describe intended designs; much of `BACKEND_PLAN.md` (real auth, durable server storage, notification delivery, document extraction) is not implemented. All legal/regulatory content is illustrative; inventory is synthetic, news is real.
