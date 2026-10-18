# Infra (Terraform)

Creates everything ExportMate runs on Google Cloud (backend and AI service) in one GCP project. Only the frontend is hosted elsewhere (Vercel), and it calls these services.

| Resource | Name |
| --- | --- |
| APIs | Cloud Run, Cloud SQL Admin, Secret Manager, Artifact Registry, Firebase, Identity Toolkit, Firestore, Vertex AI, Model Armor, Cloud Scheduler, Cloud Build, … |
| Postgres 16 (Cloud SQL, `db-f1-micro`, ~USD 10/month) | `exportmate-db`, database + user `exportmate`; extensions `vector` and `pg_trgm` (created by the backend's migration) |
| Secret | `backend-database-url` |
| Service account | `exportmate-backend` (Cloud SQL client, Firebase Auth admin, reads the secret, creates, reads and deletes regulation and supplier documents, calls Gemini on Vertex AI) |
| Image registry | `<region>-docker.pkg.dev/<project>/exportmate` |
| Cloud Run service (public) | `exportmate-backend` |
| Cloud Run job (same image, one command) | `exportmate-backend-task` |
| Firebase Auth (email + password; Google when `google_oauth_client_id` is set) + web app | config printed as `firebase_web_config` |
| Bucket (private, versioned) | `exportmate-regulation-documents-dev`: company uploads under `companies/`, shared official texts under `shared/`; the backend can create, read and delete objects (`objectUser`, `regulation_documents.tf`) |
| **AI service** (`ai_service.tf`) | |
| Firestore | `(default)`, native, asia-southeast1, with the two `kb` vector indexes (768-d) |
| Service accounts | `exportmate-ai` (Firestore user, Vertex AI user, Model Armor user), `exportmate-scheduler` (signs the scan's OIDC token, no roles) |
| Cloud Run service (public) | `exportmate-ai`, URL printed as `ai_url` |
| Cloud Run job (same image, one command) | `exportmate-ai-task` |
| Model Armor template | `exportmate-untrusted-text` (prompt injection and jailbreak at medium confidence and above, malicious links, any language), screens each new news article; set on the service as `MODEL_ARMOR_TEMPLATE`. In `us-central1` (`model_armor_region`): `asia-southeast1` lacks the malicious-link filter and multi-language detection, and only public news articles are sent to it |
| Cloud Scheduler | `exportmate-daily-news-scan`, 07:00 Asia/Ho_Chi_Minh, `POST <ai_url>/api/scan` |
| Log-based metrics | `exportmate_ai/chat_answers` (by status, policy version), `chat_latency`, `guard_withheld`, `armor_failures`, `scan_failures` |
| **Builds** (`build.tf`) | |
| Service account | `exportmate-builder` (pushes to the image registry, writes build logs) |
| Bucket | `<project>-builds`, uploaded build sources, deleted after 30 days |

Terraform creates the services and jobs with a placeholder image. `backend/deploy.sh` builds the backend image, runs migrations and rolls it out; `ai/server/deploy.sh` builds the AI image on Cloud Build and rolls it out.

`terraform apply` needs the project **Owner**: it creates the Firestore database, grants roles and makes the services public. Editors can run `terraform plan` and both deploy scripts.

## First time

```sh
PROJECT_ID=skilful-scarab-511320-q9
gcloud storage buckets create gs://$PROJECT_ID-tfstate --project $PROJECT_ID --location asia-southeast1 --uniform-bucket-level-access
gcloud storage buckets update gs://$PROJECT_ID-tfstate --versioning

cd infra/terraform
cp example.tfvars terraform.tfvars          # set project_id
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)   # or: gcloud auth application-default login
terraform init -backend-config="bucket=$PROJECT_ID-tfstate"
terraform apply                             # ~10 min, mostly Cloud SQL

cd ../..
PROJECT_ID=$PROJECT_ID backend/deploy.sh
```

Demo data for a real Firebase user (create the user first, see below). It also loads the shared trade-map reference data and the demo company's suppliers, documents and sites:

```sh
gcloud run jobs execute exportmate-backend-task --region asia-southeast1 --wait \
  --args="python -m app.seed_demo_data --email lan@example.com --firebase-uid <uid>"
```

Create a test user and get an ID token (for Postman), using `apiKey` from `terraform output firebase_web_config`:

```sh
curl -s "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=<apiKey>" \
  -H "Content-Type: application/json" \
  -d '{"email":"lan@example.com","password":"<password>","returnSecureToken":true}'
# → localId is the uid, idToken is the Bearer token (valid 1 hour)
```

The backend rejects unverified emails (`403 email_not_verified`). Mark a test user verified:

```sh
curl -s -X POST "https://identitytoolkit.googleapis.com/v1/projects/$PROJECT_ID/accounts:update" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: $PROJECT_ID" \
  -H "Content-Type: application/json" -d '{"localId":"<uid>","emailVerified":true}'
```

Get a fresh ID token later (same `apiKey`):

```sh
curl -s "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=<apiKey>" \
  -H "Content-Type: application/json" \
  -d '{"email":"lan@example.com","password":"<password>","returnSecureToken":true}'
```

If the project already has Firebase (added in the console), import it before the first apply:
`terraform import google_firebase_project.default projects/$PROJECT_ID`.

## Google sign-in

"Continue with Google" on the sign-in and sign-up pages needs the Google provider, which needs an OAuth client that Terraform can't create.

On `skilful-scarab-511320-q9` it was turned on in the Firebase console (Authentication › Sign-in method › Add new provider › Google; public-facing name ExportMate). That created the OAuth client ("Web client (auto created by Google Service)") and the consent screen, so `google_oauth_client_id` stays empty there and Terraform leaves the provider alone. The support email shown in Google's popup can be changed in Cloud console › Google Auth Platform › Branding.

On a new project, do the same in the console, or create the client yourself and let Terraform enable the provider:

1. Cloud console › Google Auth Platform › Branding: set up the consent screen (External, app name ExportMate, support email, the `exportmate.vercel.app` home page and the privacy and terms pages). Under Audience, publish the app; while it is in testing, only listed test users can sign in.
2. Clients › Create client › Web application. Authorized JavaScript origins: `https://exportmate.vercel.app`, `http://localhost:5173`, `http://127.0.0.1:5173`. Authorized redirect URI: `https://$PROJECT_ID.firebaseapp.com/__/auth/handler`.
3. Put the client ID and secret in `terraform.tfvars` (`google_oauth_client_id`, `google_oauth_client_secret`) and `terraform apply`. If the provider was already turned on in the console, import it first: `terraform import 'google_identity_platform_default_supported_idp_config.google[0]' projects/$PROJECT_ID/defaultSupportedIdpConfigs/google.com`.

The button shows whenever Firebase is configured and `VITE_AUTH_MODE` isn't `dev`. Until the provider is on, it answers "Google sign-in isn't turned on yet". Someone who already has a password for the same email is asked to sign in with it (one account per email); a Gmail address is the exception, since Google vouches for it and Firebase links it to the existing account.

## Every code change

```sh
PROJECT_ID=skilful-scarab-511320-q9 backend/deploy.sh
PROJECT_ID=skilful-scarab-511320-q9 ai/server/deploy.sh
```

## AI service tasks

The job runs one shell command with the AI image (as `exportmate-ai`, so nothing runs from a laptop). gcloud splits `--args` on commas; for a comma in the command use `--args="^;^node eval/run.js --only=a,b"`.

```sh
gcloud run jobs execute exportmate-ai-task --region asia-southeast1 --wait --args="node seed.js"      # stock + default sources + index
gcloud run jobs execute exportmate-ai-task --region asia-southeast1 --wait --args="node rag.js"       # rebuild the vector index
gcloud run jobs execute exportmate-ai-task --region asia-southeast1 --wait --args="node eval/run.js --judge"   # golden set; result in Firestore eval_runs
gcloud run jobs execute exportmate-ai-task --region asia-southeast1 --wait --args="node ops.js --days=7"       # health report
```

## Moving the AI service from exportmate-app (and onto Agent Platform)

The AI service, its Firestore data and the daily scan used to live in project `exportmate-app`, with the assistant inside the Cloud Run service. They move here in one go, with the assistant's agents on Gemini Enterprise Agent Platform (Agent Runtime, Sessions, Memory Bank, RAG Engine, Evaluation, Govern; see `docs/AGENT_HARNESS.md`). Steps marked **owner** need dylan.exportmate@gmail.com; the rest work as Editor. Every command runs from the repository root unless noted.

**Status (17 October 2026):** `exportmate-ai` here runs main with the agents inside the service (no `AGENTS_AT`), as the old one does, so the website can switch before the Agent Runtime: steps 1, 2, 4 and 8 move it, and 3 and 5–7 can follow. Until step 1 runs again there is no `<project>-kb` bucket, so the assistant's search here finds nothing and scans can't index what they find. Until step 2 runs, Firestore here has only the seed and test scans: no custom sources, companies' source settings or company alerts. The website, and the backend through `AI_SERVICE_URL`, use `exportmate-app`'s service until step 8; the daily scan runs there and is paused here.

1. **Owner:** `terraform apply` (Firestore, service accounts and grants, the Cloud Run service, job and scheduler, the RAG bucket, the APIs Agent Gateway needs, metrics, build resources). `terraform plan` should show 0 to destroy apart from the two Firestore vector indexes on `kb`, which nothing uses any more.
2. Copy the data (stock, sources and companies' source settings, articles, alerts, scans, audits) with an account that can read `exportmate-app` and write here. Documents already here are kept. Companies' goods aren't copied: they are rebuilt from the backend, and each company's first scan here reads back its recent news with this code, so those alerts carry the mentions the backend's knowledge graph walks:
   ```sh
   cd ai/server && node copy-firestore.js --from=exportmate-app --to=skilful-scarab-511320-q9 --dry-run   # then without --dry-run
   ```
3. Deploy the image to Cloud Run and create the agents' Agent Runtime instance (`exportmate-agents`, with Memory Bank and its own Agent Identity); the last line printed is the instance's name:
   ```sh
   PROJECT_ID=skilful-scarab-511320-q9 ai/server/deploy.sh
   ```
4. Build the search index on RAG Engine (creates the five corpora), then let RAG Engine read the bucket and build it again:
   ```sh
   gcloud run jobs execute exportmate-ai-task --project skilful-scarab-511320-q9 --region asia-southeast1 --wait --args="node rag.js"
   # owner: terraform apply -var rag_service_agent_ready=true, then run the job again
   ```
5. **Owner:** govern the agents: Agent Identity roles, Agent Registry, egress IAM policies, Agent Gateway with IAP and Model Armor (observe mode). Add `BACKEND_URL=<backend Cloud Run URL>` so the agents may reach it:
   ```sh
   PROJECT_ID=skilful-scarab-511320-q9 RUNTIME=<name from step 3> BACKEND_URL=<backend url> infra/agent-platform/govern.sh
   ```
   Then bind the agents to the gateway: `PROJECT_ID=skilful-scarab-511320-q9 GATEWAY=projects/skilful-scarab-511320-q9/locations/asia-southeast1/agentGateways/exportmate-egress ai/server/deploy.sh`.
6. **Owner:** point Cloud Run at the agents: `terraform apply -var agent_runtime=<name from step 3> -var rag_service_agent_ready=true` (sets `AGENTS_AT=runtime` and `AGENT_RUNTIME`).
7. Check the deployed agents: the console playground (Agent Platform › Agent Runtime › exportmate-agents) answers, and the golden set passes against them and shows on Agent Platform › Evaluation:
   ```sh
   cd ai/server && PROJECT_ID=skilful-scarab-511320-q9 AGENT_RUNTIME=<name> npm run eval:vertex -- --engine
   ```
   Check the service too: `curl "$(terraform output -raw ai_url)/"` (Cloud Run reserves `/healthz`, so check `/`).
8. Switch traffic: set the `/api/:path*` destination in `frontend/vercel.json` to this project's service (`https://exportmate-ai-3v6cd2xhpq-as.a.run.app`, the same service as `$(terraform output -raw ai_url)`) and the default project in `ai/server/db.js`, merge (Vercel deploys the website), then `terraform apply` from merged main (the backend's `AI_SERVICE_URL` follows the rewrite; until then `gcloud run services update exportmate-backend --update-env-vars AI_SERVICE_URL=<that URL>` sets the value Terraform keeps). Re-run step 2 just before merging if `exportmate-app` has had new scans or chats meanwhile. Move the daily scan at the same time, run one here so each company reads back its news, and monitor the service here:
   ```sh
   gcloud scheduler jobs resume exportmate-daily-news-scan --project skilful-scarab-511320-q9 --location asia-southeast1
   gcloud scheduler jobs pause exportmate-daily-news-scan --project exportmate-app --location asia-southeast1
   gcloud scheduler jobs run exportmate-daily-news-scan --project skilful-scarab-511320-q9 --location asia-southeast1
   PROJECT_ID=skilful-scarab-511320-q9 PART=ai SERVICE=exportmate-ai ALERT_EMAIL=… infra/monitoring/apply.sh
   ```
9. After a few days of clean Agent Gateway logs (no `DENIED` in `networkservices.googleapis.com/gateway_requests`, Model Armor `sanitize_operations` findings reviewed), **owner:** enforce with `ENFORCE=1 … infra/agent-platform/govern.sh`.
10. Retire the old project's AI resources, and the development resources made while building this (Agent Runtime instances `exportmate-agents-ai` and `exportmate-agents-dev`, the RAG corpora `exportmate-kb-*`, the bucket `exportmate-app-kb`, the Agent Gateway `exportmate-egress` and its policies, extensions and Agent Registry entries, the Model Armor template `exportmate-agent-traffic`, the image `exportmate-agents` in `cloud-run-source-deploy`):
   ```sh
   gcloud run services delete exportmate-ai --project exportmate-app --region asia-southeast1
   gcloud run services delete exportmate-chat --project exportmate-app --region asia-southeast1   # the service's earlier name; no requests since 10 Oct 2026
   ```

## Change infra

Edit the `.tf` files, then `terraform plan` and `terraform apply`.

## Move to another project / clean up

```sh
terraform destroy                 # deletes everything above, including the database
```

Then repeat "First time" with the new `project_id`. Firebase users don't move: they belong to the old project.
