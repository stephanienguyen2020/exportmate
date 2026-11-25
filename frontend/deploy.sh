#!/usr/bin/env bash
# Build the website image on Cloud Build and roll it out to the Cloud Run service exportmate-web.
# The service, its settings (BACKEND_HOST, AI_HOST) and its public access come from
# infra/terraform (web_service.tf); run `terraform apply` first.
#
# Usage (from anywhere):  PROJECT_ID=my-project frontend/deploy.sh
# The Firebase web config (public values) is read from `terraform output firebase_web_config`,
# or from FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN and FIREBASE_APP_ID.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID, e.g. PROJECT_ID=skilful-scarab-511320-q9}"
REGION="${REGION:-asia-southeast1}"
TAG="${TAG:-$(git rev-parse --short HEAD)-$(date +%Y%m%d%H%M%S)}"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/exportmate/web:$TAG"

cd "$(dirname "$0")"

if [ -z "${FIREBASE_API_KEY:-}" ]; then
  config="$(terraform -chdir=../infra/terraform output -json firebase_web_config)"
  read_config() { printf '%s' "$config" | python -c "import json, sys; print(json.load(sys.stdin)['$1'])"; }
  FIREBASE_API_KEY="$(read_config apiKey)"
  FIREBASE_AUTH_DOMAIN="$(read_config authDomain)"
  FIREBASE_APP_ID="$(read_config appId)"
fi

echo "==> Building $IMAGE on Cloud Build"
gcloud builds submit --project "$PROJECT_ID" --region "$REGION" \
  --config cloudbuild.yaml \
  --substitutions "_IMAGE=$IMAGE,_FIREBASE_API_KEY=$FIREBASE_API_KEY,_FIREBASE_AUTH_DOMAIN=$FIREBASE_AUTH_DOMAIN,_FIREBASE_PROJECT_ID=$PROJECT_ID,_FIREBASE_APP_ID=$FIREBASE_APP_ID" \
  --service-account "projects/$PROJECT_ID/serviceAccounts/exportmate-builder@$PROJECT_ID.iam.gserviceaccount.com" \
  --gcs-source-staging-dir "gs://$PROJECT_ID-builds/source" .

echo "==> Deploying the website"
gcloud run services update exportmate-web --project "$PROJECT_ID" --region "$REGION" --image "$IMAGE"

URL="$(gcloud run services describe exportmate-web --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
echo "==> Done: $URL"
