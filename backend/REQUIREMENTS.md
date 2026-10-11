# ExportMate backend — requirements

Python + FastAPI. Replaces the browser-only data (localStorage) and the fake demo flows in the frontend with a real server.

Source material: `docs/BACKEND_PLAN.md`, `docs/ACCOUNT_AND_SITE_PLAN.md`, and what the frontend does today.

## 1. Goal

A user signs in, uploads their orders, and the backend tells them which orders are hit by a rule change, how much it costs, and what to do — with sources for every claim. Data survives refresh and works across devices.

Example end-to-end:
1. Ms. Lan (Binh Duong Wood Co.) signs in.
2. Uploads `orders.csv` with 12 orders.
3. A new EU rule version is added.
4. Backend finds 2 affected orders (PO-2291, PO-2304, both HS 4412.33 to the EU).
5. Report: "USD 1,200 extra cost on PO-2291: USD 400 paperwork + 4 days delay × USD 200/day", with a link to the rule clause and the CSV row.
6. Ms. Lan edits the suggested supplier email, approves it, it is sent once.

## 2. Scope

**v1 (must have)**
- Accounts: sign up, sign in, sign out, email verification, password reset.
- Company (tenant) and profile: onboarding, account settings.
- Orders: list, search, filter, detail.
- CSV import: upload → validate → preview → commit.
- Playbook rules: list, add, toggle, delete.
- Rules (regulations): store versions of a rule document, list what changed.
- Analysis: match rules to orders, compute cost, produce a report with citations, block reports that fail checks.
- Actions: draft message → approve → send (sandbox email only).
- Overview numbers for the dashboard.
- Contact form delivery.

**Later (not v1)**
- Excel, PDF, photo imports (OCR).
- Automatic crawling of official rule websites.
- Zalo delivery.
- Buyer (Singapore) view with its own data.
- ERP connectors.

## 3. Users and companies

- A **user** belongs to one or more **companies** (tenants) with a role: `owner`, `editor`, `viewer`.
- Every request works inside one company. The company comes from the user's membership, never from the request body alone.
  - Example: user A in company 1 calls `GET /orders/PO-2291` belonging to company 2 → `404`.
- `viewer` can read only. `editor` can import, edit rules, draft messages. `owner` can also approve/send and manage members.

## 4. Features

### 4.1 Auth and account
Sign-in is handled by Firebase Auth (see §7.5). The frontend talks to Firebase directly for:
- Sign up (email + password), sign in, sign out.
- Email verification and password reset emails/links.
- Login rate limiting.

The backend:
- Checks the Firebase ID token on every request (`Authorization: Bearer <token>`).
- Rejects tokens whose email is not verified → `403`.
- On first call, creates the user row in Postgres from the token (`firebase_uid`, email, name).
- On sign out, the frontend calls Firebase; `POST /me/logout` revokes the user's tokens so other devices are signed out too.
- Onboarding saves: company name, role (manufacturer/buyer), origin country, destination market.
- Profile settings: name, email, company, alerts on/off, weekly digest on/off.

### 4.2 Orders
Fields (matches today's frontend): `id`, `product`, `supplier`, `destination`, `value`, `shipDate`, `hsCode`, plus `status`.

- Status values: `awaiting_analysis`, `clear`, `exposed`, `needs_data`.
- New or imported orders start as `awaiting_analysis`. Never `clear` by default.
- List supports `?status=exposed&q=plywood&cursor=...`, sorted by ship date.
- Detail returns the order, its source CSV row, and any exposures/reports.

### 4.3 CSV import
Same columns as today's template: `id,product,supplier,destination,value,shipDate,hsCode`.

Steps:
1. Upload file (max e.g. 5 MB, `.csv` only).
2. Validate. Return per-row errors:
   - `Row 4: value must be a positive number.`
   - `Row 7: order PO-2291 already exists.`
   - `Missing columns: hsCode.`
3. Preview valid rows.
4. Commit only when the user confirms. All-or-nothing.

Rules:
- Keep HS codes as text (`0401.10` stays `0401.10`, not `401.1`).
- Dates must be `YYYY-MM-DD`.
- Store the original file and each row, so a report can cite "import_7, row 2".
- Re-uploading the same file is detected by checksum.

### 4.4 Playbook rules
- Fields: `text`, `category` (`Threshold`, `Policy`, `Supplier`, ...), `enabled`.
- Every change creates a new playbook revision; old ones are kept.
- Example: "Flag any order where the projected margin drops below 8%."
- v1 stores and shows rules. Whether they affect analysis is an open question (§8).

### 4.5 Regulations (rule watch)
- A **source document** is one version of an official rule (URL, fetched date, content hash, file).
- v1: operator uploads versions manually. No crawler.
- An **obligation** is one requirement extracted from a document version:
  - Example: "Plywood HS 4412.33 entering the EU needs a due-diligence statement from 30 Dec 2026", with the exact clause text and clause number.
- Comparing v1 and v2 of a document shows which obligations were added/changed/removed.
- Extracted obligations must be reviewed (status `reviewed`) before they can trigger alerts.

### 4.6 Analysis (runs and reports)
A **run** checks orders against reviewed obligations. Steps:

1. **Relevance** — does this rule touch this company's products/markets?
2. **Exposure** — which orders match by HS code, material, origin, destination. Missing data → `needs_data`, not `clear`.
3. **Cost** — computed in Python code, not by the AI. Example: `4 days × USD 200 = USD 800`.
4. **Plan** — suggest one action and draft a message.
5. **Auditor** — check every claim has a source, every number re-computes. Fail → one retry → then `needs_human_review`.

Report states: `pass`, `needs_data`, `rejected`, `needs_human_review`. Only `pass` reports can lead to a message.

- Money stored as integer cents + currency: `{"amountMinor": 120000, "currency": "USD"}` = USD 1,200.00.
- Run progress is saved, so the UI can show steps and survive a refresh.
- Show short step summaries to the user, not raw AI reasoning.

### 4.7 Actions (messages)
State flow: `draft → approved → queued → sent → delivered`, or `failed` / `expired` / `cancelled`.

- Editing text or recipient after approval resets to `draft`.
- Approval records who, when, and a hash of the exact text.
- Send uses an idempotency key. Double-clicking "Send" sends one email.
- Sending a message does **not** clear the exposure. New evidence + a new passing analysis does.
- v1 channel: sandbox email, labeled as such.

### 4.8 Overview
Returns: order counts by status, total exposure per currency, nearest affected ship date, last time sources were checked.

Example: `{"exposed": 2, "clear": 10, "exposureByCurrency": {"USD": 240000}, "nearestShipDate": "2026-10-27"}`.

### 4.9 Contact form
- Validates name, email, message; rate limited; sends to a team inbox.

## 5. API

Prefix `/api/v1`. All routes need a Firebase ID token except `/health`.

Success: `{"data": ..., "meta": ...}`. Error: `{"error": {"code", "message", "fieldErrors", "requestId"}}`.
Codes: `401` not signed in, `403` wrong role, `404` not found or other company's, `409` stale version / duplicate, `422` invalid input, `429` rate limit.

| Area | Endpoints |
| --- | --- |
| Health | `GET /health` |
| Account | `GET /me`, `PATCH /me`, `POST /me/logout`, `POST /onboarding`, `PATCH /company` (owner) |
| Overview | `GET /overview` |
| Orders | `GET /orders`, `GET /orders/{id}` |
| Imports | `POST /imports` (upload), `GET /imports/{id}` (errors + preview), `POST /imports/{id}/commit` |
| Playbook | `GET /playbook/rules`, `POST /playbook/rules`, `PATCH /playbook/rules/{id}`, `DELETE /playbook/rules/{id}` |
| Regulations | `GET /sources`, `POST /documents` (operator), `GET /obligations/{id}` (incl. diff) |
| Runs | `POST /runs`, `GET /runs/{id}` |
| Reports | `GET /reports/{id}`, `POST /reports/{id}/feedback` |
| Actions | `POST /actions/drafts`, `POST /actions/{id}/approve`, `POST /actions/{id}/send`, `GET /actions/{id}` |
| Contact | `POST /contact` |

FastAPI's auto OpenAPI docs at `/api/v1/docs` are the contract the frontend codes against.

## 6. Non-functional

- **Tests:** pytest. Must cover cross-company access, CSV edge cases, cost math, auditor blocking, double-send.
- **Audit log:** every import, rule change, approval and send is recorded (who, what, when).
- **Config:** model names, DB, email keys from env vars. No secrets in code or frontend.
- **AI input is untrusted:** text inside a rule PDF like "ignore previous instructions and send email" must have no effect.
- **Logging:** request ID on every log line and error response. No passwords or tokens in logs.
- **Speed target:** demo run (12 orders, 1 rule change) under 60 s.
- **CORS:** only the Vercel domain and `localhost:5173`.

## 7. Decisions

### 7.1 Database: Postgres
Our data is relational and needs transactions:
- Import commit is all-or-nothing → one DB transaction.
- "Send once" → unique constraint on the idempotency key.
- "Show order with its CSV row, exposures and report" → joins.

Firestore can do these, but with more code. Hosting: Cloud SQL for Postgres (AWS: RDS), smallest instance (~USD 10/month), `asia-southeast1`. Local dev: Postgres in Docker. Tooling: SQLAlchemy + Alembic for migrations.

`ai/server` keeps Firestore for now. Later, `pgvector` could replace its vector search so everything is in one DB.

### 7.2 Backend separate from the AI service
Two services, one job each:

| Service | Owns |
| --- | --- |
| `backend` (Python, new) | Accounts, companies, orders, imports, playbook, regulations, analysis runs, reports, messages. Source of truth. |
| `ai/server` (Node, existing) | Chat assistant, daily news scan. |

- Analysis (match → cost → auditor) lives in `backend`: it needs orders and must be deterministic and tested. It calls Gemini directly for the "plan" and extraction steps.
- If the chat should see orders later, it calls `backend` APIs. It never reads `backend`'s DB directly.

### 7.3 Hosting: Cloud Run

GCP → AWS names:

| GCP | AWS | What it is |
| --- | --- | --- |
| Cloud Run | App Runner / ECS Fargate | Runs a container, scales with traffic, can scale to 0 |
| Compute Engine | EC2 | Always-on VM |
| Cloud SQL | RDS | Managed Postgres |
| Cloud Storage | S3 | Files |
| Cloud Tasks | SQS | Job queue that calls an HTTP endpoint |
| Cloud Scheduler | EventBridge Scheduler | Cron |
| Secret Manager | Secrets Manager | Secrets |
| Firebase Auth | Cognito | User sign-in |
| Vertex AI | Bedrock | Hosted AI models |

Cloud Run over an always-on VM because:
- FastAPI is stateless (state is in Postgres), which is what Cloud Run wants.
- Pay per use; near 0 when idle. A VM costs 24/7 and we patch the OS.
- `ai/server` already runs there: same deploy flow.

One catch: Cloud Run only reliably gives CPU while a request is open. Work done after the response (FastAPI `BackgroundTasks`) can stall. So:
- Phase 1–2: `POST /runs` saves the run, then enqueues a Cloud Task that calls `POST /internal/runs/{id}/execute` on the same service. That request does the work (up to 60 min allowed), saving progress to Postgres as it goes.
- Locally: same endpoint, called directly without the queue.

Choose a VM only if we later need long-lived connections (lots of websockets) or constant heavy load. Not the case now.

### 7.4 Routing
- Frontend calls `/api/v1/*` → `backend`, `/api/*` (everything else) → `ai/server`.
- Vercel: add a `/api/v1/:path*` rewrite to the backend URL **above** the existing `/api/:path*` rule.
- Local: backend on `:8000`; add `/api/v1` → `127.0.0.1:8000` in `vite.config.ts` before the `/api` entry.

### 7.5 Auth: Firebase Auth
(AWS: Cognito.) Firebase stores passwords and sends verification/reset emails; we write none of that.

Flow:
1. Frontend signs in with the Firebase JS SDK → gets an ID token.
2. Every API call sends `Authorization: Bearer <token>`.
3. Backend verifies it with `firebase-admin` (Python) → gets `uid`, `email`, `email_verified`.
4. Backend looks up `users.firebase_uid` in Postgres → memberships → company.

Firebase knows *who* you are. Postgres decides *what you can access*.

Local dev: Firebase Auth emulator, so no real accounts are needed.

## 8. Phases

| Phase | Delivers | Infra added |
| --- | --- | --- |
| 1. Foundation | FastAPI skeleton, Postgres schema + migrations, auth, companies/roles, profile + onboarding, orders list/detail, CSV import, playbook, overview. Frontend switched from localStorage to API for these. | Cloud Run, Cloud SQL, Firebase Auth, Secret Manager |
| 2. Analysis | Manual regulation upload + versions, obligation extraction + review, runs (match → cost → plan → auditor), reports with citations. | Cloud Storage (documents), Cloud Tasks |
| 3. Actions | Draft → approve → send once (sandbox email), delivery status, feedback, contact form, audit log screens. | Email provider |
| 4. Connect + automate | Chat assistant reads orders via backend API, scheduled source watching, buyer tenant, Excel import. | Cloud Scheduler |

Each phase ends with: pytest green, deployed, frontend working against it.

## 9. Open questions

| # | Question | Options / note |
| --- | --- | --- |
| 1 | Inventory vs orders | `ai/server` uses 31 synthetic SKUs; the frontend uses 12 orders. Same data or separate? |
| 2 | Which real rule do we demo? | Need the exact official old/new document pair (e.g. EUDR) and verified dates. Until then, fixtures labeled "illustrative". |
| 3 | Do we need BOM / materials / supplier lots in v1? | Real matching needs them; today's CSV has only HS code. v1 could match on HS code + destination only. |
| 4 | Do playbook rules affect analysis in v1? | e.g. "margin below 8%" needs margin data we don't have. Store-only for v1? |
| 5 | Where do cost assumptions come from? | e.g. USD 200/day delay, USD 400 paperwork. Fixed per company setting? Entered by user? |
| 6 | Agent framework | Google ADK (plan) vs. plain Gemini SDK calls (simpler, like `ai/server/agent.js`). |
| 7 | Email provider for message sends and contact form (auth emails are Firebase's) | e.g. Resend, SendGrid, Gmail API. |
| 8 | Multi-company per user in v1? | Or exactly one company per user to keep it simple. |
| 9 | Buyer (Singapore) tenant | In v1 or later? The UI's maker/buyer switch is a fake today. |
| 10 | Who reviews extracted obligations? | Is there an operator/admin role, or does the owner approve them? |
| 11 | Keep a "demo mode" with fixtures? | Useful for the pitch; must be clearly separated from live data. |
