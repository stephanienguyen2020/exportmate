#!/usr/bin/env bash
# Build the Order features job's image on Cloud Build and roll it out to the job.
# Infra (bucket, job, secret, schedule) comes from infra/terraform/trade_risk.tf; run
# `terraform apply` first. The data and the model are in the ML bucket, not the image:
# `ml/upload.sh` copies them there.
#
# Usage (from anywhere):  PROJECT_ID=my-project ml/deploy.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID, e.g. PROJECT_ID=skilful-scarab-511320-q9}"
REGION="${REGION:-asia-southeast1}"
TAG="${TAG:-$(git rev-parse --short HEAD)-$(date +%Y%m%d%H%M%S)}"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/exportmate/order-features:$TAG"

cd "$(dirname "$0")"

echo "==> Building $IMAGE on Cloud Build"
gcloud builds submit --project "$PROJECT_ID" --region "$REGION" \
  --config cloudbuild.yaml --substitutions "_IMAGE=$IMAGE" \
  --service-account "projects/$PROJECT_ID/serviceAccounts/exportmate-builder@$PROJECT_ID.iam.gserviceaccount.com" \
  --gcs-source-staging-dir "gs://$PROJECT_ID-builds/source" .

echo "==> Updating the job"
gcloud run jobs update exportmate-order-features --project "$PROJECT_ID" --region "$REGION" --image "$IMAGE"

echo "==> Done. First time: load the case list with"
echo "    gcloud run jobs execute exportmate-order-features --project $PROJECT_ID --region $REGION --args=--cases --wait"
