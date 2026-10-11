# ExportMate

A responsive trade-compliance frontend for small manufacturers, inspired by the supplied editorial design reference. Built with React, TypeScript, Vite, Lucide icons, and Papa Parse.

## Deployment

Production: [exportmate.vercel.app](https://exportmate.vercel.app). Vercel project: `exportmate` under `stephanies-projects-5bf9fd09`. Build configuration is in `vercel.json`; temporary files and local environment files are excluded by `.vercelignore`.

## Run

```sh
npm install
npm run dev
```

Open the local URL printed by Vite (normally http://127.0.0.1:5173). `npm run build` type-checks and produces `dist/`; `npm run preview` serves the production build. The sample demo needs no credentials. Signed-in workspaces require the backend and Firebase configuration below.

## Company API integration

The signed-in workspace uses the FastAPI contracts in `backend/app/schemas`: account/profile and onboarding, paginated orders and original CSV row details, overview, two-step CSV validation/commit, and playbook CRUD. Firebase handles sign-in, signup, email verification and password recovery. Requests use refreshed Firebase ID tokens. Viewer accounts cannot import or change rules; company settings require an owner.

Copy `.env.example` to `.env.local` and fill in the Firebase **web app** configuration. For Vercel, set `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, and the server-side `BACKEND_URL` (the deployed FastAPI HTTPS origin), then redeploy. Enable Firebase email/password sign-in and authorize `exportmate.vercel.app` in Firebase Authentication. The backend must use the same Firebase project. Never put service-account keys or database credentials in `VITE_*` variables.

`/api/v1/*` is routed through `api/backend.ts` to `BACKEND_URL`; the broader `/api/*` AI rewrite remains separate. Missing backend configuration returns a clear 503 rather than routing company requests to the AI service. `VITE_BACKEND_API_URL` can optionally point directly to a backend `/api/v1` endpoint when its CORS allows the frontend. Local Vite routes `/api/v1` to port 8000 and `/api` to port 8080.

For local backend development, use `VITE_AUTH_MODE=dev` together with backend `AUTH_MODE=dev`, seed the backend, and sign in as `lan@example.com` with any password of at least eight characters. Development tokens are disabled in production builds. “Explore the demo” remains an explicitly browser-local sample workspace; it never falls back from a failed API request to sample records. Live order statuses and currencies come from the server. Exposure reports, analysis and supplier actions remain pending backend phases and are not presented as live reports.

CSV imports use server validation and explicit commit; repeated clicks are blocked. The Vercel upload path uses a 4 MB file limit to leave room for multipart overhead. Backend uploads made directly support the backend's 5 MB limit.

Verification: `npm run build`; `npx playwright install chromium` once, then `npm test`. Browser integration tests exercise contract-shaped API responses, pagination, bearer headers, errors, roles, imports, playbook mutations, profile updates, onboarding, logout and demo isolation. With the local backend running, `TEST_REAL_BACKEND=1 npm test` also exercises a real FastAPI/Postgres round trip in a separate test company. Deployed Firebase authentication still needs its own end-to-end check.

## AI features (Google Cloud)

All AI code lives in [`ai/`](ai/): the chat UI in [`ai/chat/`](ai/chat/), News watch in [`ai/news/`](ai/news/), and one Node service in [`ai/server/`](ai/server/) that serves every `/api/*` route.

- **Assistant (RAG agent):** a launcher at the bottom-right of every screen; `#/chat` is the full-screen view with the session's audit trail. Gemini on Vertex AI plans and calls tools in a loop ([`ai/server/agent.js`](ai/server/agent.js)): `search_knowledge` (vector search), `query_inventory` and `get_alerts` (exact Firestore lookups), `calculate` (arithmetic, so figures are traceable) and `get_scan_status`. Every fact is cited with a numbered source. Before an answer is returned, an auditor step checks that citations resolve to retrieved evidence and that figures appear in tool results; a failing draft goes back to the model once.
- **Vector database:** Firestore vector search over `gemini-embedding-001` embeddings (768 dimensions, cosine), in the `kb` collection ([`ai/server/rag.js`](ai/server/rag.js)). Indexed: stock items, news articles, alerts, sources and help guides ([`ai/server/seed/guides.js`](ai/server/seed/guides.js)). Each scan indexes its new articles and alerts; `npm run index` rebuilds everything and removes stale entries.
- **Audit trail:** each answer streams its steps live (NDJSON) and stores an audit record in `audits`: question, reasoning summaries, every tool call with arguments and retrieved evidence (with similarity scores), auditor findings, checks, citations, model, token usage and timing. Open "Audit" under any answer, or the side panel on `#/chat`, which reloads the session's records from Firestore. Records can be downloaded as JSON. `GET /api/audits?session=<id>` returns only that session's records.
- **News watch** (`#/workspace/news`, plus a section on Overview): every day at 07:00 Asia/Ho_Chi_Minh, Cloud Scheduler calls `POST /api/scan`. The service reads the enabled RSS/Atom sources, skips articles it has already analysed, and asks Gemini which stock items each new article could affect. Alerts store severity, direction (risk/opportunity/watch), affected SKUs with reasons, stock value exposed, and a next step.
- **Data:** Firestore (`asia-southeast1`) holds `inventory` (31 synthetic SKUs for a Vietnamese wood-products and furniture exporter), `sources`, `articles`, `impacts`, `scans`, `kb` (vector index) and `audits`. The industry was chosen because current news moves it: EUDR, US Section 232 timber/furniture tariffs, plywood trade cases. Stock is fictional; news is real.
- **Sources:** seven built-in feeds (Timber Trades Journal, VnExpress International, European Commission press corner, four Google News searches). Users can add any public HTTPS feed; the server tests it first and blocks private/metadata addresses.

### Google Cloud resources (project `exportmate-app`)

| Resource | Name |
| --- | --- |
| Cloud Run service | `exportmate-ai` (asia-southeast1), runs as `exportmate-chat@…` with `roles/aiplatform.user` and `roles/datastore.user` |
| Firestore | `(default)` database, native mode, asia-southeast1; vector indexes on `kb.embedding` and `(kb.type, kb.embedding)` |
| Cloud Scheduler | `exportmate-daily-news-scan`, OIDC-signed as `exportmate-scheduler@…` |
| Models | `gemini-2.5-flash` for the agent and scans (`GEMINI_MODEL`), `gemini-embedding-001` for embeddings (`EMBED_MODEL`), both via Vertex AI |

`vercel.json` rewrites `/api/*` to the Cloud Run URL; locally `vite.config.ts` proxies `/api` to `127.0.0.1:8080`.

### Run and deploy

```sh
gcloud auth application-default login
cd ai/server && npm install
npm run seed   # load synthetic stock and default sources, then rebuild the vector index
npm run scan   # run one news scan now (add --lookback=14 to re-read two weeks)
npm run index  # rebuild the vector index; `node rag.js "<query>"` runs a test search
npm run dev    # API on :8080 (run `npm run dev` in the repo root too)
gcloud run deploy exportmate-ai --source . --region asia-southeast1 --project exportmate-app
```

The API is public for the prototype (max 3 instances). "Scan now" is limited to one scan per 10 minutes; the signed scheduler request skips that limit. Chat questions and answers are stored in `audits`. Alerts and answers are AI assessments of headlines and snippets, not legal advice. Signed-in orders and playbook rules live in the FastAPI backend; the assistant cannot see them yet. Sample-demo records remain browser-local.

## Explore

The public landing at `#/` includes full How it works, About, and Contact sections with parallax photography and 3D layers. Account pages include `#/login`, `#/signup`, `#/verify-email`, `#/forgot-password`, `#/check-email`, `#/reset-password`, `#/onboarding`, and `#/logout`. Use the demo CTA to enter `#/workspace`; profile settings are at `#/workspace/account`. Account forms use Firebase when configured. The sample-demo entry remains available without an account.

- **Overview:** corridor snapshot, exposure metrics and prioritized action.
- **Orders:** search, status filters and order-impact detail.
- **Rule watch:** sample sources, before/after requirement and the simulated five-agent review.
- **Data room:** upload a CSV, inspect validation/preview, explicitly import; download a starter template.
- **Playbook:** add, toggle and delete browser-local policies.
- **Impact detail:** inspect cost assumptions and evidence; edit and confirm a simulated supplier message.

Use “See ExportMate in action” or “Run rule-change demo” to walk from clear seed orders to two exposures, including an auditor rejection. The demo resets seed risk flags and demo confirmations, preserving imported orders. Imported records remain “Awaiting analysis.”

The Maker/Buyer view switch illustrates separately seeded USD/SGD estimates. It is not tenant authorization or a currency conversion. All legal content is illustrative, and no external messages are sent.

Browser storage keys: `em-orders`, `em-rules`, `em-sent`, `em-profile`, `em-inquiry`; session storage: `em-session`, `em-next`. Clear those keys in browser developer tools to reset persisted prototype data. Browser storage is not suitable for sensitive production data.

## Planning documents

- [Page plan](docs/FRONTEND_PLAN.md)
- [Complete site and account flow](docs/ACCOUNT_AND_SITE_PLAN.md)
- [Landing design and artwork prompt](docs/LANDING_DESIGN.md)
- [Backend architecture and implementation checklist](docs/BACKEND_PLAN.md)

## Assets

Port photography: [Unsplash image](https://images.unsplash.com/photo-1578575437130-527eed3abbec), stored locally at `public/port.jpg`. DM Sans and DM Mono load from Google Fonts with system fallbacks. Icons: Lucide. The image is illustrative global-trade photography, not a claim that the depicted port is on the demo corridor.

## Scope

The frontend integrates the available phase-one company APIs and the existing AI service. Live company access requires the deployed backend URL and Firebase web configuration. Regulation analysis, supplier message delivery, document extraction and chat access to company orders remain future backend work.
