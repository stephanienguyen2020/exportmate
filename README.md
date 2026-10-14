# ExportMate

A responsive trade-compliance frontend for small manufacturers, inspired by the supplied editorial design reference. Built with React, TypeScript, Vite, Lucide icons, and Papa Parse.

## Deployment

Production: [exportmate.vercel.app](https://exportmate.vercel.app). Vercel project: `exportmate` under `stephanies-projects-5bf9fd09`. Build configuration is in `frontend/vercel.json`; temporary files and local environment files are excluded by `frontend/.vercelignore`.

## Repository layout

- `frontend/`: React screens, chat/news UI, static assets, API proxy, tests, frontend docs and build/deploy configuration.
- `backend/`: FastAPI company API, database migrations and API documentation.
- `ai/server/`: AI service, independent from the browser app.
- `infra/`: shared cloud infrastructure.

The `main` branch requires a pull request and passing `frontend`, `backend`, and `ai-server` checks, including for administrators. Force pushes and branch deletion are disabled.

## Regulation library

`#/workspace/regulations` lists shared official texts and company references. Search by title or official ID, inspect version history, and download exact source files. Owners/editors can upload a new PDF/HTML/TXT reference or a new version of a company regulation (up to 4 MB). Shared texts are read-only. Trade-map requirement citations link to exact source document versions. Uploads store reference files; requirement extraction and analysis remain planned backend features.

## Run

```sh
cd frontend
npm install
npm run dev
```

Open the local URL printed by Vite (normally http://127.0.0.1:5173). `npm run build` type-checks and produces `dist/`; `npm run preview` serves the production build. The sample demo needs no credentials. Signed-in workspaces require the backend and Firebase configuration below.

To run the whole stack (Postgres, backend, AI service and frontend) with one command, use `./dev.sh` from the repository root. It needs Docker and [uv](https://docs.astral.sh/uv/), installs dependencies when lockfiles change, migrates and seeds the database, and uses dev sign-in: log in as `lan@example.com` with any password of 8+ characters. Ctrl+C stops everything except Postgres.

## Company API integration

The signed-in workspace uses the FastAPI contracts in `backend/app/schemas`: account/profile and onboarding, paginated orders and original CSV row details, overview, two-step CSV validation/commit, and playbook CRUD. Firebase handles sign-in, signup, email verification and password recovery. Requests use refreshed Firebase ID tokens. Viewer accounts cannot import or change rules; company settings require an owner.

Copy `frontend/.env.example` to `frontend/.env.local` and fill in the Firebase **web app** configuration. For Vercel, set `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, and the server-side `BACKEND_URL` (the deployed FastAPI HTTPS origin), then redeploy. Enable Firebase email/password sign-in and authorize `exportmate.vercel.app` in Firebase Authentication. The backend must use the same Firebase project. Never put service-account keys or database credentials in `VITE_*` variables.

`/api/v1/*` is routed through `frontend/api/backend.ts` to `BACKEND_URL`; the broader `/api/*` AI rewrite remains separate. Missing backend configuration returns a clear 503 rather than routing company requests to the AI service. `VITE_BACKEND_API_URL` can optionally point directly to a backend `/api/v1` endpoint when its CORS allows the frontend. Local Vite routes `/api/v1` to port 8000 and `/api` to port 8080.

For local backend development, use `VITE_AUTH_MODE=dev` together with backend `AUTH_MODE=dev`, seed the backend, and sign in as `lan@example.com` with any password of at least eight characters. Development tokens are disabled in production builds. “Explore the demo” remains an explicitly browser-local sample workspace; it never falls back from a failed API request to sample records. Live order statuses and currencies come from the server. Exposure reports, analysis and supplier actions remain pending backend phases and are not presented as live reports.

CSV imports use server validation and explicit commit; repeated clicks are blocked. The Vercel upload path uses a 4 MB file limit to leave room for multipart overhead. The backend enforces the same 4 MB limit.

Verification (from `frontend/`): `npm run build`; `npx playwright install chromium` once, then `npm test` (Node 22.18+ for the proxy test). Browser integration tests exercise contract-shaped API responses, pagination, bearer headers, errors, roles, imports, playbook mutations, profile updates, onboarding, logout, demo isolation and who may change News watch sources. GitHub Actions (`.github/workflows/ci.yml`) runs these plus the backend's ruff, `alembic check` and pytest on every push to main and every pull request. With the local backend running, `TEST_REAL_BACKEND=1 npm test` also exercises a real FastAPI/Postgres round trip in a separate test company. Deployed Firebase authentication still needs its own end-to-end check.

## AI features (Google Cloud)

How to use the assistant and News watch, and how they work: [docs/AI_GUIDE.md](docs/AI_GUIDE.md).

The chat UI lives in [`frontend/ai/chat/`](frontend/ai/chat/), News watch in [`frontend/ai/news/`](frontend/ai/news/), and one Node service in [`ai/server/`](ai/server/) that serves every `/api/*` route.

- **Assistant (RAG agent):** a launcher at the bottom-right of every screen; `#/chat` is the full-screen view with the session's audit trail. Gemini on Vertex AI plans and calls tools in a loop ([`ai/server/agent.js`](ai/server/agent.js)): `search_knowledge` (vector search), `query_inventory` and `get_alerts` (exact Firestore lookups), `calculate` (arithmetic, so figures are traceable), `get_scan_status`, and the workspace's own `query_orders` and `get_playbook` (plus `get_company_profile` when signed in). Every fact is cited with a numbered source. Before an answer is returned, an auditor step checks that citations resolve to retrieved evidence, that figures appear in tool results, that cited news is dated and that links are retrieved sources; a failing draft goes back to the model once, and one that still fails is shown marked "Needs review". Each question goes to a small fast model or a bigger one by rules (`router.js`).
- **Vector database:** Firestore vector search over `gemini-embedding-001` embeddings (768 dimensions, cosine), in the `kb` collection ([`ai/server/rag.js`](ai/server/rag.js)). Indexed: stock items, news articles, alerts, sources and help guides ([`ai/server/seed/guides.js`](ai/server/seed/guides.js)). Each scan indexes its new articles and alerts; `npm run index` rebuilds everything and removes stale entries.
- **Audit trail:** each answer streams its steps live (NDJSON) and stores an audit record in `audits`: question, reasoning summaries, every tool call with arguments and retrieved evidence (with similarity scores), auditor findings, checks, citations, model, token usage and timing. Open "Audit" under any answer, or the side panel on `#/chat`, which reloads the session's records from Firestore. Records can be downloaded as JSON. `GET /api/audits?session=<id>` returns only that session's records.
- **News watch** (`#/workspace/news`, plus a section on Overview): every day at 07:00 Asia/Ho_Chi_Minh, Cloud Scheduler calls `POST /api/scan`. The service reads the enabled RSS/Atom sources, skips articles it has already analysed, and asks Gemini which stock items each new article could affect. Alerts store severity, direction (risk/opportunity/watch), affected SKUs with reasons, stock value exposed, and a next step.
- **Data:** Firestore (`asia-southeast1`) holds `inventory` (31 synthetic SKUs for a Vietnamese wood-products and furniture exporter), `sources`, `articles`, `impacts`, `scans`, `kb` (vector index) and `audits`. The industry was chosen because current news moves it: EUDR, US Section 232 timber/furniture tariffs, plywood trade cases. Stock is fictional; news is real.
- **Sources:** seven built-in feeds (Timber Trades Journal, VnExpress International, European Commission press corner, four Google News searches). Signed-in company owners and editors can add any public HTTPS feed and switch sources on or off; sources are shared by every workspace, so the service checks the caller's role with the backend (`GET /api/v1/me`, which needs `BACKEND_URL` set on the service). The server tests a new feed first and blocks private/metadata addresses. The sample demo and viewer accounts see the sources read-only.

### Google Cloud resources

Everything runs in one project, `skilful-scarab-511320-q9`, defined in [`infra/terraform`](infra/terraform/) (`ai_service.tf`, `build.tf`). Until the move in [`infra/terraform/README.md`](infra/terraform/README.md#moving-the-ai-service-from-exportmate-app) is finished, the live AI service and its data are still in `exportmate-app`.

| Resource | Name |
| --- | --- |
| Cloud Run service | `exportmate-ai` (asia-southeast1), runs as `exportmate-ai@…` with `roles/aiplatform.user` and `roles/datastore.user` only |
| Cloud Run job | `exportmate-ai-task` (same image): seed, re-index, scan, eval, ops |
| Firestore | `(default)` database, native mode, asia-southeast1; vector indexes on `kb.embedding` and `(kb.type, kb.embedding)` |
| Cloud Scheduler | `exportmate-daily-news-scan`, OIDC-signed as `exportmate-scheduler@…` |
| Cloud Build | images built as `exportmate-builder@…` into the `exportmate` Artifact Registry repo |
| Agent Platform Evaluation | experiment "ExportMate assistant" (us-central1): golden-set runs scored by managed judges (`npm run eval:vertex`) |
| Cloud Logging / Monitoring | JSON logs; log-based metrics `exportmate_ai/chat_answers`, `chat_latency`, `guard_withheld`, `scan_failures` |
| Models | Assistant: `gemini-3.5-flash-lite` for simple questions and `gemini-4-argon` for complex ones (`GEMINI_MODEL_SIMPLE`, `GEMINI_MODEL_COMPLEX`); scans and the eval judge: `gemini-3.5-flash` (`GEMINI_MODEL`); embeddings: `gemini-embedding-001` (`EMBED_MODEL`); all via Vertex AI. These are the code defaults (`ai/server/models.js`); `GET /healthz` reports what the service runs |

`frontend/vercel.json` rewrites `/api/*` to the Cloud Run URL; locally `frontend/vite.config.ts` proxies `/api` to `127.0.0.1:8080`.

### Run and deploy

```sh
gcloud auth application-default login
cd ai/server && npm install
npm run seed   # load synthetic stock and default sources, then rebuild the vector index
npm run scan   # run one news scan now (add --lookback=14 to re-read two weeks)
npm run index  # rebuild the vector index; `node rag.js "<query>"` runs a test search
npm run dev    # API on :8080 (run `npm run dev` in frontend/ too)
npm test       # harness unit tests; `npm run eval` runs the golden set against Gemini
PROJECT_ID=skilful-scarab-511320-q9 ./deploy.sh   # build on Cloud Build, roll out the service and job
```

The API is public for the prototype (max 3 instances). Chat is capped per hour at 40 questions per client and 200 per instance (`CHAT_LIMIT_PER_CLIENT`, `CHAT_LIMIT_PER_INSTANCE`). "Scan now" is limited to one scan per 10 minutes; the signed scheduler request skips that limit. Chat questions and answers are stored in `audits`. Alerts and answers are AI assessments of headlines and snippets, not legal advice. Signed-in orders and playbook rules live in the FastAPI backend, and the assistant reads them with the user's own token. Sample-demo records remain browser-local; the demo's orders and switched-on rules travel with each chat question so the assistant can read them.

## Explore

The public landing at `#/` includes full How it works, About, and Contact sections with parallax photography and 3D layers. Account pages include `#/login`, `#/signup`, `#/verify-email`, `#/forgot-password`, `#/check-email`, `#/reset-password`, `#/onboarding`, and `#/logout`. Use the demo CTA to enter `#/workspace`; profile settings are at `#/workspace/account`. Account forms use Firebase when configured. The sample-demo entry remains available without an account.

- **Overview:** corridor snapshot, exposure metrics and prioritized action.
- **Orders:** search, status filters and order-impact detail.
- **Rule watch:** sample sources, before/after requirement and the simulated five-agent review (signed in: the requirements behind your orders' market checklists, with their official texts).
- **Data room:** upload a CSV, inspect validation/preview, explicitly import; download a starter template. Imported demo orders are checked against the sample rule change like the seeded ones.
- **Playbook:** add, toggle and delete browser-local policies; the assistant applies the ones switched on.
- **Impact detail:** inspect cost assumptions and evidence; edit and confirm a simulated supplier message.

Use “See ExportMate in action” or “Run rule-change demo” to walk from clear orders to the ones the sample rule change affects (two in the seed), including an auditor rejection. The demo resets the seed orders and demo confirmations and keeps imported orders, checking every order against the rule (`sampleCheck` in `frontend/src/data.ts`): EU-bound HS 4412.33 or acacia products whose supplier has no geolocation record. Counts, costs, dates and the next affected shipment are worked out from the orders, the demo's cost assumptions (`sampleCosts`) and today's date; seed ship dates count from today.

The Maker/Buyer view switch illustrates separately seeded USD/SGD estimates. It is not tenant authorization or a currency conversion. All legal content is illustrative, and no external messages are sent.

Browser storage keys: `em-orders`, `em-rules`, `em-sent`, `em-profile`, `em-inquiry`; session storage: `em-session`, `em-next`. Clear those keys in browser developer tools to reset persisted prototype data. Browser storage is not suitable for sensitive production data.

## Planning documents

- [Page plan](frontend/docs/FRONTEND_PLAN.md)
- [Complete site and account flow](frontend/docs/ACCOUNT_AND_SITE_PLAN.md)
- [Landing design and artwork prompt](frontend/docs/LANDING_DESIGN.md)
- Backend: [requirements](backend/docs/REQUIREMENTS.md), [technical decisions](backend/docs/DECISIONS.md), [API](backend/docs/API.md), [original implementation plan](backend/docs/BACKEND_PLAN.md)

## Assets

Port photography: [Unsplash image](https://images.unsplash.com/photo-1578575437130-527eed3abbec), stored locally at `frontend/public/port.jpg`. DM Sans and DM Mono load from Google Fonts with system fallbacks. Icons: Lucide. The image is illustrative global-trade photography, not a claim that the depicted port is on the demo corridor.

## Scope

The frontend integrates the available phase-one company APIs and the existing AI service. Live company access requires the deployed backend URL and Firebase web configuration. Regulation analysis, supplier message delivery and document extraction remain future backend work.

## Deploy frontend

The Vercel project `exportmate` uses Root Directory `frontend`, Vite, and `frontend/vercel.json`. Run `vercel --prod` from the repository root after linking the project. Configure Firebase web variables and `BACKEND_URL` in Vercel for both Production and Preview; never enable dev auth in deployment. GitHub PRs create preview deployments; merging to `main` deploys production.
