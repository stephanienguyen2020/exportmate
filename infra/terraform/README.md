# Infra (Terraform)

Creates everything ExportMate runs on Google Cloud (backend and AI service) in one GCP project. Only the frontend is hosted elsewhere (Vercel), and it calls these services.

| Resource | Name |
| --- | --- |
| APIs | Cloud Run, Cloud SQL Admin, Secret Manager, Artifact Registry, Firebase, Identity Toolkit, Firestore, Vertex AI, Cloud Scheduler, Cloud Build, … |
| Postgres 16 (Cloud SQL, `db-f1-micro`, ~USD 10/month) | `exportmate-db`, database + user `exportmate` |
| Secret | `backend-database-url` |
| Service account | `exportmate-backend` (Cloud SQL client, Firebase Auth admin, reads the secret) |
| Image registry | `<region>-docker.pkg.dev/<project>/exportmate` |
| Cloud Run service (public) | `exportmate-backend` |
| Cloud Run job (same image, one command) | `exportmate-backend-task` |
| Firebase Auth (email + password) + web app | config printed as `firebase_web_config` |
| Bucket (private, versioned) | `exportmate-regulation-documents-dev`, backend can read and create objects (`regulation_documents.tf`) |
| **AI service** (`ai_service.tf`) | |
| Firestore | `(default)`, native, asia-southeast1, with the two `kb` vector indexes (768-d) |
| Service accounts | `exportmate-ai` (Firestore user, Vertex AI user), `exportmate-scheduler` (signs the scan's OIDC token, no roles) |
| Cloud Run service (public) | `exportmate-ai`, URL printed as `ai_url` |
| Cloud Run job (same image, one command) | `exportmate-ai-task` |
| Cloud Scheduler | `exportmate-daily-news-scan`, 07:00 Asia/Ho_Chi_Minh, `POST <ai_url>/api/scan` |
| Log-based metrics | `exportmate_ai/chat_answers` (by status, policy version), `chat_latency`, `guard_withheld`, `scan_failures` |
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

The backend rejects unverified emails (`403 email_not_verified`). For a test user, mark it verified in the Firebase console (Authentication → Users), or send the verification email from the frontend.

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

## Moving the AI service from exportmate-app

The AI service, its Firestore data and the daily scan used to live in project `exportmate-app`. To move them here:

1. **Owner:** `terraform apply` (creates Firestore, service accounts and grants, the service, job, scheduler, metrics and build resources). `terraform plan` should show 0 to destroy.
2. Deploy the code: `PROJECT_ID=skilful-scarab-511320-q9 ai/server/deploy.sh`.
3. Copy the data (stock, sources, articles, alerts, scans, vector index, audits), with an account that can read `exportmate-app` and write here:
   ```sh
   cd ai/server && node copy-firestore.js --from=exportmate-app --to=skilful-scarab-511320-q9
   ```
4. Check the new service before switching traffic: `curl "$(terraform output -raw ai_url)/"` (Cloud Run reserves `/healthz`, so check `/`), then run the eval job above.
5. Switch traffic: set the `/api/:path*` destination in `vercel.json` to `$(terraform output -raw ai_url)/api/:path*`, set the default project in `ai/server/db.js` and the comment in `dev.sh` to `skilful-scarab-511320-q9`, then deploy the frontend. Re-run step 3 just before this if `exportmate-app` has had new scans or chats meanwhile.
6. Retire the old project's AI resources:
   ```sh
   gcloud scheduler jobs pause exportmate-daily-news-scan --project exportmate-app --location asia-southeast1
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
