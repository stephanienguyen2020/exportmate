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

## The assistant on Agent Platform

The website's AI service, its Firestore data, the daily scan and the assistant's agents all run here (moved from `exportmate-app` on 18 October 2026). The Cloud Run service `exportmate-ai` serves every `/api/*` route. The agents' Agent Runtime instance `exportmate-agents` (`projects/360016804920/locations/asia-southeast1/reasoningEngines/8488414484384186368`) runs the same image as its own Agent Identity, with Sessions and Memory Bank, behind the egress Agent Gateway `exportmate-egress` (IAP egress policy and Model Armor, both in observe mode).

Chats are relayed to the instance (`AGENTS_AT=runtime`; `var.agent_runtime` defaults to it, so every apply keeps it). The gateway ends any request after 60 seconds, so the agents' complex tier thinks at LOW there (`ai/server/deploy.sh` sets `GEMINI_THINKING_COMPLEX`): at MEDIUM one `gemini-4-argon` call can take longer, and 4 of 18 golden cases failed (the gateway answered 500 after 60.2 s). At LOW the golden set passed 16 of 18 against the instance on 18 October (17 of 18 run locally at LOW; `eu-missing-geolocation` misses SKUs in both, on the simple tier).

`ai/server/deploy.sh` (Every code change, above) updates the service, the job and the agents; it keeps the agents behind the gateway and gives them the backend's URL. `rag_service_agent_ready` defaults to true here (RAG Engine reads the bucket).

**Owner:** run `infra/agent-platform/govern.sh` again whenever an endpoint is added (it is safe to run again; it needs a recent gcloud, with `agent-registry`):

```sh
PROJECT_ID=skilful-scarab-511320-q9 RUNTIME=projects/360016804920/locations/asia-southeast1/reasoningEngines/8488414484384186368 BACKEND_URL=https://exportmate-backend-3v6cd2xhpq-as.a.run.app infra/agent-platform/govern.sh
```

Check the agents: the console playground (Agent Platform › Agent Runtime › exportmate-agents) answers, and the golden set passes against them (shown on Agent Platform › Evaluation):

```sh
cd ai/server && PROJECT_ID=skilful-scarab-511320-q9 AGENT_RUNTIME=projects/360016804920/locations/asia-southeast1/reasoningEngines/8488414484384186368 npm run eval:vertex -- --engine
```

Still to do:

1. After a few days of clean Agent Gateway logs (no `DENIED` in `networkservices.googleapis.com/gateway_requests`, Model Armor `sanitize_operations` findings reviewed), **owner:** enforce with `ENFORCE=1 … infra/agent-platform/govern.sh`.
2. Retire `exportmate-app`'s AI resources (its daily scan is paused), and the development resources made while building this (Agent Runtime instances `exportmate-agents-ai` and `exportmate-agents-dev`, the RAG corpora `exportmate-kb-*`, the bucket `exportmate-app-kb`, its Agent Gateway `exportmate-egress` with its policies, extensions and Agent Registry entries, the Model Armor template `exportmate-agent-traffic`, the image `exportmate-agents` in `cloud-run-source-deploy`):
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
