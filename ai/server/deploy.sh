#!/usr/bin/env bash
# Build the AI service image on Cloud Build, then roll it out to the Cloud Run
# service and the one-off job. Infra (Firestore, service account, service, job,
# scheduler) comes from infra/terraform; run `terraform apply` first.
#
# Usage (from anywhere):  PROJECT_ID=my-project ai/server/deploy.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID, e.g. PROJECT_ID=skilful-scarab-511320-q9}"
REGION="${REGION:-asia-southeast1}"
TAG="${TAG:-$(git rev-parse --short HEAD)-$(date +%Y%m%d%H%M%S)}"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/exportmate/ai:$TAG"

cd "$(dirname "$0")"

echo "==> Building $IMAGE on Cloud Build"
gcloud builds submit --project "$PROJECT_ID" --region "$REGION" \
  --config cloudbuild.yaml --substitutions "_IMAGE=$IMAGE" \
  --service-account "projects/$PROJECT_ID/serviceAccounts/exportmate-builder@$PROJECT_ID.iam.gserviceaccount.com" \
  --gcs-source-staging-dir "gs://$PROJECT_ID-builds/source" .

echo "==> Updating job"
gcloud run jobs update exportmate-ai-task --project "$PROJECT_ID" --region "$REGION" --image "$IMAGE"

echo "==> Deploying service"
gcloud run services update exportmate-ai --project "$PROJECT_ID" --region "$REGION" --image "$IMAGE"

URL="$(gcloud run services describe exportmate-ai --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
echo "==> Done: $URL/ (health check; Cloud Run reserves /healthz)"
