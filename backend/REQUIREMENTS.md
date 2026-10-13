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

### 2.1 Assumptions

**Every official rule we match on names HS codes.**
- News articles rarely have HS codes. They are only the **trigger**. The conditions come from the **official text** (regulation, customs notice), which usually lists HS codes, often in an annex.
- If the official text has no codes (e.g. only "wooden furniture"), the AI suggests codes (`9403.x`), marked **AI-suggested**. Matching orders go to review, not `exposed`, until a person confirms.

**Products are matched by HS code, not by name.**
- "Acacia plywood 18 mm", "Ván ép keo" and "Plywood AC-18" all have HS `4412.33`, so they count as the same product.
- An order without an HS code is `needs_data`. The AI may suggest a code from the product name; the user confirms it.

**HS codes are a tree. A rule on a parent code covers every child under it.**

```text
44          Wood and articles of wood          (chapter)
└─ 4412     Plywood, veneered panels            (heading)
   ├─ 4412.10  of bamboo
   ├─ 4412.33  other, with outer ply of certain hardwoods   ← PO-2291
   └─ 4412.39  other
      └─ 4412.39.10  (national level: EU, US and Vietnam add 2–4 more digits)
```

Matching is a prefix check plus exceptions:

```text
rule:  include HS 4412, except 4412.10
4412.33  → starts with 4412, not 4412.10 → MATCH
4412.10  → excluded                      → no match
4418.99  → different heading             → no match
```

The first 6 digits are the same in every country; digits after that differ by country. Match on 6 digits unless the rule names a longer code.

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
- Onboarding saves: company name, role (manufacturer/buyer), trade route — origin country, up to 3 transit stops in order (empty = direct), destination market. The owner can change the route later in About company (`PATCH /company`).
- Onboarding also requires a short company description (what the company does).
- About company (Account; owner edits, others read): name, role, route, description, products, main materials and their origin, certifications, website, year founded, team size. It is the company's entry in the knowledge base: the AI assistant reads it through `GET /company/knowledge`.
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
1. Upload file (max 4 MB, `.csv` only; 60 uploads per user per hour).
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
- A **regulation** is one official rule (e.g. "EU deforestation regulation", official ID `32023R1115`).
- A **regulation document** is one uploaded file (title, source URL, content hash, file in Cloud Storage). **v1: every upload is a version of a regulation**, whether it is an official text or a news article (an article is a regulation with one version). Official rule vs article only matters once there is a shared library (§11.2).
- **New version = the uploader says so.** On upload they pick "new regulation" or "new version of [regulation ▾]". The frontend can pre-select the regulation when the typed official ID matches (`GET /regulations?officialId=`). Same file again (same hash) → `409 already_uploaded`. Official ID already used → `409 regulation_exists`.
- Files: `.pdf`, `.html`, `.txt`, up to 4 MB (the Vercel proxy accepts about 4.5 MB), 60 uploads per user per hour. Not the same as supplier documents (§4.9: proof a supplier holds). Downloads are always attachments (uploaded HTML is never rendered on our domain).
- v1: manual upload only. No crawler, no fetching URLs (the source URL is stored as a reference).
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

### 4.9 Trade map
A map of the company's own export activity: where its suppliers, sites and markets are, and the orders between them.
- Selecting a market shows its orders, changes to check (orders needing action, tariff checks, News watch items naming the market) and missing supplier documents.
- "What if this order went to another market?": documents that can be reused, requirements to re-evaluate (new or changed), and what the data can't conclude. Paperwork only; the customer, contract and sales case still decide.
- Satellite observations (e.g. flood extents) are extra evidence: suppliers and sites within `FLOOD_CHECK_RADIUS_KM` get a check-in prompt. Order impact is never inferred; statuses don't change.
- Data: shared reference tables (markets, countries, ports, document kinds, per-market checklists, observations) and company tables (suppliers, supplier documents, sites). Orders match suppliers by name. Checklists are illustrative until obligations come from reviewed documents (§4.5); observations are samples until a real source is connected.

### 4.10 Contact form
- Validates name, email, message; rate limited; sends to a team inbox.

## 5. API

Prefix `/api/v1`. All routes need a Firebase ID token except `/health`.

Success: `{"data": ..., "meta": ...}`. Error: `{"error": {"code", "message", "fieldErrors", "requestId"}}`.
Codes: `401` not signed in, `403` wrong role, `404` not found or other company's, `409` stale version / duplicate, `422` invalid input, `429` rate limit.

| Area | Endpoints |
| --- | --- |
| Health | `GET /health` |
| Account | `GET /me`, `PATCH /me`, `POST /me/logout`, `POST /onboarding`, `PATCH /company` (owner), `GET /company/knowledge` (profile + sites, for the AI assistant) |
| Overview | `GET /overview` |
| Orders | `GET /orders`, `GET /orders/{id}` |
| Imports | `POST /imports` (upload), `GET /imports/{id}` (errors + preview), `POST /imports/{id}/commit` |
| Playbook | `GET /playbook/rules`, `POST /playbook/rules`, `PATCH /playbook/rules/{id}`, `DELETE /playbook/rules/{id}` |
| Regulations | `POST /regulation-documents` (editor), `GET /regulation-documents/{id}`, `GET /regulation-documents/{id}/file`, `GET /regulations?officialId=`, `GET /regulations/{id}` (versions, newest first) — **built**. Later: `GET /sources`, `GET /obligations/{id}` (incl. diff) |
| Runs | `POST /runs`, `GET /runs/{id}` |
| Reports | `GET /reports/{id}`, `POST /reports/{id}/feedback` |
| Actions | `POST /actions/drafts`, `POST /actions/{id}/approve`, `POST /actions/{id}/send`, `GET /actions/{id}` |
| Trade map | `GET /trade-map`, `GET /trade-map/compare?orderId=&market=` |
| Contact | `POST /contact` |

FastAPI's auto OpenAPI docs at `/api/v1/docs` are the contract the frontend codes against.

## 6. Non-functional

- **Tests:** pytest. Must cover cross-company access, CSV edge cases, cost math, auditor blocking, double-send.
- **Audit log:** every import, rule change, approval and send is recorded (who, what, when).
- **Config:** model names, DB, email keys from env vars. No secrets in code or frontend.
- **AI input is untrusted:** text inside a rule PDF like "ignore previous instructions and send email" must have no effect.
- **Logging:** request ID on every log line and error response. No passwords or tokens in logs. One `request.completed` line per request (method, path, status, duration, user and company IDs); JSON lines in production for Cloud Logging, grouped by Cloud Trace.
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
- The company profile already works this way: in a signed-in session the frontend sends the user's Firebase token with `/api/chat`, and `ai/server` calls `GET /api/v1/company/knowledge` (env `BACKEND_URL`) with it. Demo chats stay anonymous.

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
| 12 | ~~How do we get from a news article to the official text?~~ | **Decided:** v1 manual upload; later official APIs; stretch: agent search + human confirm. See §11. |
| 13 | ~~How much of the code do we match on?~~ | **Decided:** 6 digits, prefix check in code, no AI. See §11. |
| 14 | ~~Rule amendments~~ | **Decided:** v1 operator uploads the consolidated text; stretch: agent drafts merged conditions, human reviews. See §11. |
| 15 | ~~Who confirms AI-suggested HS codes?~~ | **Decided:** company `editor`; the CSV value is never overwritten. See §11.5. |
| 23 | Where does crawling live? | **Leaning `ai/server`.** It now has per-company sources in Firestore: shared built-in sources (a company can switch one off for itself) plus private sources a company adds (`ai/server/access.js`). Still open: does the backend `watch_sources` table (§11.3) replace this, or does the backend read sources from `ai/server`? |
| 24 | Operator role | Platform staff (us) who review the shared rule library. A flag on `users`, or a separate admin app? Until we have one, the company owner reviews their own uploads. |
| 25 | Shared vs private rules | **Direction decided, later phase.** v1: everything is per company; the company uploads both official texts and articles. Later: official law lives in a shared library (`company_id` null), written only by the operator and the crawler (J1). Companies **follow** regulations (many-to-many `company_regulations`), can request a missing one, and upload only their own files (articles, evidence). Matching checks only followed regulations. Still open: can a company keep a private rule (e.g. a buyer's own requirement)? |
| 16 | Conditions that aren't HS codes | Origin country, company size, order value thresholds, wood species. How do we store them next to HS codes? Some need data we don't have (see 3). |
| 17 | ~~Markets vs countries~~ | **Partly decided (trade map):** `countries` + `markets` tables, a market groups countries (EU = 27). The destination text is parsed (`Rotterdam, NL` → NL, or a known port name → its country); no CSV column. |
| 18 | Which documents does a rule require? | **For now, hand-made per market:** the trade map's `market_requirements` (each with a `document_kind`) are illustrative checklists. Still open: once `obligations` are extracted and reviewed, do they fill these checklists or replace them? |
| 19 | Document storage | Uploaded certificates: file in Cloud Storage + row in Postgres + embedding for search. Which vector store: Firestore (like `ai/server`) or `pgvector`? |
| 20 | When do checks re-run? | On import, rule change, document upload, daily expiry check, "ready to ship" click. All in v1? |
| 21 | Language | Vietnamese UI, Vietnamese documents for OCR, English rules. Translate in reports? |
| 22 | How do we test AI quality? | A fixed set of rules, orders and documents with expected results, run on every prompt or model change. |

## 10. AI/agent ideas to discuss

On top of §4.5–4.7. Not decided; listed so we can pick. Some ideas come from a past winning project (`docs/GLOBOT_ARCHITECTURE.md`).

Design rule for all of them: **AI reads and writes. Code decides and calculates. A person approves.**

| # | Idea | What it does | AI vs code | Example |
| --- | --- | --- | --- | --- |
| A | Official-text finder | From a news article, find the official rule it talks about | AI finds and quotes; operator confirms | News "EU tightens timber rules" → link to the regulation and its annex |
| B | HS code suggester | Suggest a code for orders without one | AI suggests; user confirms | "Ván ép keo 18 mm" → `4412.33` (confidence 0.8) |
| C | Rule-to-conditions extractor | Turn rule text into `hs_include`, `hs_exclude`, `markets`, `applies_from`, required documents | AI extracts with a quote per field; reviewed before use | "Annex I: 4412, except 4412.10" → `{include:["4412"], exclude:["4412.10"]}` |
| D | Document reader | Read uploaded certificates into fixed fields (type, number, issuer, expiry, products) | AI extracts (Gemini with a fixed output schema); code checks dates | FSC certificate PDF → `{type:"FSC", expiry:"2026-12-15"}` |
| E | Missing-document check | Decide `clear` vs `exposed` from required vs uploaded documents | Code decides; AI only finds documents with different names | Required "due-diligence statement", uploaded "DDS_PO2304.pdf" → found |
| F | Expiry watcher | Daily: flag documents that expire before an order's ship date | Code only | FSC expires 15 Dec, ship date 5 Jan → `exposed` |
| G | Amendment differ | When a rule changes, show which orders change status | AI spots "amends X"; code compares old and new conditions | Start date moved → PO-2304 `exposed` → `clear` |
| H | Assumption challenger | A second AI pass questions the cost and plan before the auditor | AI questions; code re-computes | "USD 200/day delay: where from? Not in company settings" → `needs_data` |
| I | Supplier email drafter | Draft the request, following the playbook | AI drafts; person approves and sends | "Please send the DDS by 15 Dec (3 weeks, per agreement)" |
| J | Reply reader | Read the supplier's reply and attachments, then re-run the check | AI reads; code re-checks | Reply with DDS attached → PO-2304 `clear` |
| K | "Ready to ship" gate | Final check when the user marks an order ready | Code checks; person confirms, logged | "1 document missing, ship anyway?" |
| L | Weekly digest | Summary email: new rules, status changes, expiring documents | AI writes; numbers from code | "2 orders newly exposed, 1 certificate expires in 14 days" |
| M | Live progress stream | Show each agent step and its sources as it runs | Same NDJSON step format as `ai/server` chat | "Matching 12 orders… 2 exposed" |
| N | AI test set | Fixed rules, orders and documents with expected answers, run on every prompt or model change | Code | 20 cases, must stay ≥ 95% correct |

Design points open for discussion:
- **One agent with tools vs several agents in sequence.** One agent is faster and cheaper; several are easier to explain in a demo. Globot used 3–5 in sequence.
- **Low confidence goes to a review queue** (e.g. under 0.8), not to `exposed` or `clear`.
- **Store every AI output with its source quote, model name and prompt version**, so a report can be re-checked later.
- **Vertex AI with the service account** (no API keys), with fixed output schemas for every extraction.

## 11. Rule sources and matching: roadmap

Everything not marked **built** is a goal. We can pitch the whole path, labelled by level, while we build it.

### 11.1 Levels

| Level | Sources | Rule text | Matching | Status |
| --- | --- | --- | --- | --- |
| 0 | 7 fixed news feeds (Timber Trades Journal, VnExpress, EU press releases, Google News searches). Users can add RSS feeds, but the list is shared by all companies. | — | `ai/server` maps articles to its 31 SKUs (AI) | **Built** (`ai/server`) |
| 1 | + Manual upload of an official rule (PDF/URL) or a single article | Operator uploads the consolidated (merged) version | 6-digit HS prefix + exceptions (code). AI suggests HS codes for orders without one. | Phase 2 |
| 2 | + Per-company watch list (`watch_sources`) + official APIs: US Federal Register, EUR-Lex | Same | Same | Phase 4 |
| 3 (stretch) | + Agent goes from a news article to the official text (Gemini grounding with Google Search, EUR-Lex search); a person confirms | Agent spots amendments and drafts merged conditions; a person reviews. Version detection without the uploader picking (see below) | + AI flags CSV codes that don't fit the product; 8–10 digit national codes when a rule names them | Goal |
| 4 (stretch) | + Vietnamese official sources, more markets (US, Japan, Korea) | Same | Same | Goal |

Pitch line: "The agent finds the likely official text and shows it to you. You confirm it before it's used."

**Knowing a file is a new version of a regulation.** Built: the uploader picks it. Goals, in order:

| Way | How | Level |
| --- | --- | --- |
| Same URL, new content | The crawler fetches a known URL again and the hash changed → next version of the same regulation | 2 |
| Official ID | Read the ID from the file (EUR-Lex CELEX: `32023R1115` original, `02023R1115-20241226` consolidated; US: `7 CFR 357`). Same base ID → same regulation; the date orders versions | 2 (suggest), 3 (automatic) |
| AI match | AI compares title and summary with existing regulations: "looks like a new version of X"; a person confirms | 3 |

A wrong automatic link would diff unrelated texts and raise wrong alerts, so every automatic way starts as a suggestion.

### 11.2 Roles

| Who | Does |
| --- | --- |
| **Operator** (our staff) | Maintains the shared rule library: uploads official texts, reviews extracted conditions. Until this role exists, the company owner reviews their own uploads. |
| Company **editor** | Uploads articles and company documents, confirms AI-suggested HS codes, manages watch sources. |
| Company **owner** | Everything an editor does + approves outgoing messages. |

### 11.3 Storage (high level)

| Table | Holds |
| --- | --- |
| `watch_sources` | `company_id` (null = shared), `url`, `kind` (`rss`, `federal_register`, `eurlex`, `page`), `enabled`, `last_checked_at` |
| `regulations` | **Built.** A regulation (e.g. "EU deforestation regulation"), optional official ID, `company_id` |
| `regulation_documents` | **Built.** One uploaded file = one version: `regulation_id` + `version_number`, title, source URL, Cloud Storage path, content hash, `company_id`. Later: `kind` (`official_rule`, `article`), `company_id` null = shared library, fetched date for crawled files |
| `company_regulations` | Later. Which company follows which shared regulation (many-to-many) |
| `obligations` | Conditions extracted from a version: `hs_include`, `hs_exclude`, `markets`, `applies_from`, `required_documents`, a source quote per field, `status` (`draft` → `reviewed`) |
| `market_requirements` | **Built (trade map), placeholder.** Hand-made checklist per market, each line with a `document_kind`. Stands in for `obligations.required_documents` until those exist (see open question 18) |
| `hs_code_suggestions` | `order_id`, suggested code, confidence, reason, `status` (`pending` / `accepted` / `rejected`), who decided |

Files live in Cloud Storage; Postgres keeps the row and the hash.

### 11.4 AI jobs (high level)

Each job runs as a Cloud Task (§7.3), saves its steps, and stores every AI output with its source quote, model and prompt version.

**J1 Crawl** (daily, Cloud Scheduler)
For each enabled `watch_source`: fetch new items → skip ones already seen (by hash) → save to `regulation_documents` → queue J2 or J3.

**J2 Analyse article**
1. AI: is this a rule change, a disruption or noise?
2. AI: which markets and products does it mention? Compare with the company's markets and order HS codes.
3. (Level 3) AI: search for the official text (Google Search grounding, EUR-Lex). Show the top candidates with links.
4. Output: an alert, "EU timber rule update may affect 2 of your orders; suggested official text: [link], confirm?"

**J3 Extract from official text**
1. AI (fixed output schema): conditions + required documents, with the exact clause quoted for each field.
2. Saved as `draft`. The operator reviews and edits → `reviewed`.
3. If it's a new version of an existing rule: compare its conditions with the previous version → list what changed → queue J4.

**J4 Match orders** (code only, no AI)
For each reviewed obligation × each company order: 6-digit prefix + exceptions + market + date → `clear` / `exposed` / `needs_data`. Only orders whose status changed raise an alert.

**J5 Suggest HS code** (when an order has no code)
1. AI: top 3 codes from the product name and description, each with a reason and confidence.
2. Saved as `pending`. The order stays `needs_data`.
3. The editor accepts one → the order gets the code → J4 runs for that order.

### 11.5 HS code cases

| Case | What happens |
| --- | --- |
| CSV has a code | Use it. No AI. |
| CSV code is empty | J5 suggests; the editor confirms; then matching runs. |
| CSV code looks wrong for the product (e.g. "Milk powder" + 4412.33) | Level 3: AI flags "code doesn't look like the product". The CSV value stays; the editor decides. |
| Excel/PDF import (later) | Same as an empty code. |

Matching itself is always code (prefix check), never AI, so the same input always gives the same answer.
