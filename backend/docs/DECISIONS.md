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
| `ai/server` (Node) | Chat assistant, daily news scan. |

- Analysis (match → cost → auditor) lives in `backend`: it needs orders and must be deterministic and tested. It calls Gemini directly for the "plan" and extraction steps.
- `ai/server` never reads the backend's DB. It calls the backend's API with the user's own token: the company profile for chat (`BACKEND_URL`) and the user's role before changing news sources. Demo chats stay anonymous.

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

One catch: Cloud Run only reliably gives CPU while a request is open, so work after the response (FastAPI `BackgroundTasks`) can stall. Plan for runs (phase 2): starting a run saves it and enqueues a Cloud Task that calls an internal endpoint on the same service; that request does the work (up to 60 min), saving progress as it goes. Locally the internal endpoint is called directly.

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
- Order: save the file, then commit the row. A failed commit deletes the file again; the bucket's versioning keeps it recoverable. The backend's role on the bucket is `objectUser` (create, read, delete objects).
- CSV imports are the exception: small files, kept in Postgres with their rows (`imports.content`).

## 8. Official texts (seed)

- `app/seed_data/regulation_sources.json` lists each shared regulation and its versions: a `download` URL (machine-readable; some sites block scripts or cloud servers) and a `sourceUrl` (the page a person opens).
- `seed_reference_data` (run by every deploy) downloads a text only when no document with that `sourceUrl` is stored, so a deploy normally downloads nothing. A failed download skips that text and the market requirements citing it, and is retried next deploy. Per-read timeout 60 s; files up to 50 MB.
- EU texts come from the EU Publications Office (`publications.europa.eu/resource/celex/<CELEX>` with an `Accept` header), because EUR-Lex blocks scripts.

## 9. Limits

- Uploads: 4 MB (the Vercel function accepts about 4.5 MB), 60 per user per hour per upload type. Counted in memory per Cloud Run instance, so it stops runaway scripts but isn't a quota.
- CSV: 10,000 rows. Uncommitted imports are deleted after 30 days (`python -m app.cleanup_imports`).
