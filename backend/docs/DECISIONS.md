# ExportMate backend — technical decisions

How the backend is built and why. What it must do is in [REQUIREMENTS.md](REQUIREMENTS.md); endpoints are in [API.md](API.md); commands are in [README.md](../README.md); cloud resources are in [infra/terraform/README.md](../../infra/terraform/README.md).

## 1. Database: Postgres

Our data is relational and needs transactions:
- Import commit is all-or-nothing → one DB transaction.
- "Send once" → unique constraint on the idempotency key.
- "Show order with its CSV row, exposures and report" → joins.

Firestore can do these, but with more code.
- Hosting: Cloud SQL for Postgres 16 (AWS: RDS), `db-f1-micro` (~USD 10/month), `asia-southeast1`.
- Local: Postgres in Docker (`docker compose up -d`, port 5433).
- Tooling: SQLAlchemy + Alembic. Migrations run in a Cloud Run job on every deploy (`deploy.sh`), followed by the reference seed.
- `ai/server` keeps Firestore for now. Later, `pgvector` could replace its vector search so everything is in one DB.

## 2. Backend separate from the AI service

| Service | Owns |
| --- | --- |
| `backend` (Python) | Accounts, companies, orders, imports, playbook, regulations, trade map, analysis runs, reports, messages. Source of truth. |
| `ai/server` (Node) | Chat assistant (Google ADK), daily news scan, News watch alerts. |

- Analysis (match → cost → playbook → plan → auditor) lives in `backend`: it needs orders and must be deterministic and tested, so every step is code. The backend calls Gemini to read uploaded supplier documents, draft a company's requirements and suggest HS codes (§9), never to decide.
- Neither service reads the other's database; each calls the other's API with the user's own token. `ai/server` reads the company profile, orders (`GET /trade-map`), the playbook and the user's role (`BACKEND_URL`). The backend's company report reads News watch alerts (`GET /api/impacts`, `AI_SERVICE_URL`). Demo chats stay anonymous.

## 3. Code layout

- `api/` (HTTP only) → `services/` (business logic, own `db.commit()`) → `database/queries/` (the only place that builds SQL, never commits) → `database/models/` (tables). `schemas/` are pydantic models with camelCase JSON; `core/` has config, auth, errors, storage.
- Company scoping: routes take a `ViewerContext` / `EditorContext` / `OwnerContext`; the company comes from the caller's membership, never the request. Other companies' records return 404.
- v1: one company per user (the oldest membership). The `memberships` table allows more later (open question 8).
- Money: integer hundredths of the currency unit + ISO 4217 currency, for every currency (also JPY and VND).

## 4. Hosting: Cloud Run

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

Cloud Run over an always-on VM:
- FastAPI is stateless (state is in Postgres), which is what Cloud Run wants.
- Pay per use; near 0 when idle. A VM costs 24/7 and we patch the OS.
- `ai/server` already runs there: same deploy flow.

One catch: Cloud Run only reliably gives CPU while a request is open, so work after the response (FastAPI `BackgroundTasks`) can stall. Phase 2 runs need no AI and finish inside `POST /runs`, so they don't queue. When a step waits on AI (the phase 3 message draft), starting a run will save it and enqueue a Cloud Task that calls an internal endpoint on the same service; that request does the work (up to 60 min), saving progress as it goes. Locally the internal endpoint is called directly.

Choose a VM only if we later need long-lived connections or constant heavy load.

Infra is Terraform (`infra/terraform/`), one GCP project, all resources "dev" tier for now (`exportmate-<thing>-dev`).

## 5. Routing

- The frontend calls `/api/v1/*` for the backend and `/api/*` for `ai/server`.
- Vercel: `/api/v1/*` goes to the function `api/backend.ts`, which forwards to `BACKEND_URL` (the Cloud Run URL stays out of the browser bundle). Other `/api/*` is rewritten to the AI service. The `/api/v1` rule comes first.
- Local: `vite.config.ts` proxies `/api/v1` to `127.0.0.1:8000` (or `BACKEND_URL`) and `/api` to `ai/server`.
- CORS: only the Vercel domain and `localhost` / `127.0.0.1:5173`.

## 6. Auth: Firebase Auth

Firebase stores passwords and sends verification and reset emails; we write none of that.

1. The frontend signs in with the Firebase JS SDK (loaded on first use), by email and password or with Google (a popup) → ID token. Google tokens arrive with the email verified; the backend treats both the same.
2. Every API call sends `Authorization: Bearer <token>`.
3. The backend verifies it with `firebase-admin` → `uid`, `email`, `email_verified`. Unverified emails get 403. The revocation check is cached for 60 s per instance.
4. The backend looks up `users.firebase_uid` → membership → company and role.

Firebase knows *who* you are. Postgres decides *what you can access*.

Local: `AUTH_MODE=dev` accepts `Bearer dev:<email>` (no Firebase). Production refuses to start with it.

## 7. Files: Cloud Storage

- One private, versioned bucket: `exportmate-regulation-documents-dev`. Company uploads under `companies/<id>/`, shared official texts under `shared/regulation-documents/`. Used locally too (`gcloud auth application-default login`); tests use an in-memory fake.
- Postgres keeps the row (title, source URL, SHA-256 hash, path). Files are never overwritten (`if_generation_match=0`).
- Supplier documents uploaded as files go under `companies/<id>/supplier-documents/`.
- Order: save the file, then commit the row. A failed commit deletes the file again; the bucket's versioning keeps it recoverable. The backend's role on the bucket is `objectUser` (create, read, delete objects).
- CSV imports are the exception: small files, kept in Postgres with their rows (`imports.content`).

## 8. Official texts (seed)

- `app/seed_data/regulation_sources.json` lists each shared regulation and its versions: a `download` URL (machine-readable; some sites block scripts or cloud servers) and a `sourceUrl` (the page a person opens).
- `seed_reference_data` (run by every deploy) downloads a text only when no document with that `sourceUrl` is stored, so a deploy normally downloads nothing. A failed download skips that text and the market requirements citing it, and is retried next deploy. Per-read timeout 60 s; files up to 50 MB.
- EU texts come from the EU Publications Office (`publications.europa.eu/resource/celex/<CELEX>` with an `Accept` header), because EUR-Lex blocks scripts.

## 9. AI: Gemini on Vertex AI

- The backend calls Gemini through `app/core/gemini.py` for three steps: reading uploaded supplier documents, drafting a company's market requirements from its own regulation, and suggesting HS codes. Each answer is a draft a person confirms. Plain SDK calls (`google-genai`), no agent framework (REQUIREMENTS.md open question 6): code runs the steps in a fixed order, and the AI only reads or writes text inside one.
- Every call asks for JSON in a fixed shape (`response_schema`, temperature 0). Code checks the answer before saving (known markets and document kinds, quotes found in the document's text, real tariff lines, dates that parse), and a person reviews it before it counts.
- Uploaded files and spreadsheet text are untrusted: they are fenced in the prompt (`<document>`, `<product>`) or sent as a file, and the prompt says to ignore instructions inside them. Prompts and answers are never logged; logs carry the task name, model and duration.
- Settings: `GOOGLE_CLOUD_PROJECT` (required), `GEMINI_MODEL` (default `gemini-2.5-flash`), `GEMINI_LOCATION` (`global`). The backend's service account has `roles/aiplatform.user`. Without a project, AI routes return `503 ai_not_configured`; a failed call returns `503 ai_unavailable` and nothing is saved. Tests replace `generate_json` with a fake.
- Analysis, matching, costs and playbook rules are code, never AI, so the same input always gives the same answer.
- The chat assistant (`ai/server`) is separate: a Google ADK agent with a model router, with its own harness (`docs/AGENT_HARNESS.md`).

## 10. Retrieval: the method that fits each case

| Searched | How | Why |
| --- | --- | --- |
| Official HS headings (`hs_headings`, ~2,500 lines from the USITC HTS) | Embeddings (`gemini-embedding-001`, 768 dimensions) in **pgvector**, computed once at seed time for new or changed lines; cosine distance at query time | Product names rarely use the tariff's words ("Shaker kitchen cabinet set" vs "Wooden furniture of a kind used in the kitchen"), and embeddings also match across languages. The list is fixed and small |
| The company's past orders with a code | Word similarity (`pg_trgm`, `similarity ≥ 0.3`, trigram index on `orders.product`) | Companies reuse their own wording; no AI call per import |
| Sections of a long regulation, while drafting | Embeddings in memory (nothing stored); shared words if embedding fails | Each document is read once. Texts up to ~120,000 characters go whole |
| PDF text | `pypdf`; under 200 letters per page counts as a scan, which Gemini reads as a file | Quotes can be checked against the text; a scan's quotes are marked unchecked |

- Local Postgres and CI use the `pgvector/pgvector:pg16` image; the migration runs `CREATE EXTENSION vector` and `pg_trgm` (both on Cloud SQL for Postgres 16).
- The reference seed embeds headings through Vertex AI. If that fails, the headings still load and suggestions search them by words; the next deploy embeds them.
- Tests use a fake embedder (word-hashing vectors), so nearest-neighbour search is tested without Gemini.

## 11. Email: Resend

- Reports are emailed through Resend (`core/email.py`); without `RESEND_API_KEY` it is a sandbox that builds and audits the email but delivers nothing. Auth emails stay Firebase's.
- Sending once: an optional `Idempotency-Key` (Resend keeps it 24 hours) and a row lock; a sent report is locked.
- Supplier messages use the same sender, after the owner approves the exact text; replies go to the approver's own email. The public contact form goes to `CONTACT_INBOX` (the ExportMate team's address, a Terraform variable) with replies to the visitor.
- Delivery confirmation (`delivered`, bounces) would need a Resend webhook: a public endpoint and a signing secret. Not built; a sent message is `sent`.

## 12. Limits

- Uploads: 4 MB (the Vercel function accepts about 4.5 MB), 60 per user per hour per upload type. Analysis runs: 60. Report emails: 20 (`REPORT_EMAILS_PER_HOUR`). Requirement drafts: 20; HS suggestions: 60; supplier message drafts: 30. The contact form: 5 per visitor IP (the first `X-Forwarded-For` address). Counted in memory per Cloud Run instance, so it stops runaway scripts but isn't a quota.
- CSV: 10,000 rows. Uncommitted imports are deleted after 30 days (`python -m app.cleanup_imports`).
