# Infra (Terraform)

Creates everything the backend needs in one GCP project:

| Resource | Name |
| --- | --- |
| APIs | Cloud Run, Cloud SQL Admin, Secret Manager, Artifact Registry, Firebase, Identity Toolkit, … |
| Postgres 16 (Cloud SQL, `db-f1-micro`, ~USD 10/month) | `exportmate-db`, database + user `exportmate` |
| Secret | `backend-database-url` |
| Service account | `exportmate-backend` (Cloud SQL client, Firebase Auth admin, reads the secret) |
| Image registry | `<region>-docker.pkg.dev/<project>/exportmate` |
| Cloud Run service (public) | `exportmate-backend` |
| Cloud Run job (same image, one command) | `exportmate-backend-task` |
| Firebase Auth (email + password) + web app | config printed as `firebase_web_config` |

Terraform creates the service and job with a placeholder image. `backend/deploy.sh` builds the real image, runs migrations, and rolls it out.

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

Demo data for a real Firebase user (create the user first, see below):

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
```

## Change infra

Edit the `.tf` files, then `terraform plan` and `terraform apply`.

## Move to another project / clean up

```sh
terraform destroy                 # deletes everything above, including the database
```

Then repeat "First time" with the new `project_id`. Firebase users don't move: they belong to the old project.
