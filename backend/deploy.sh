#!/usr/bin/env bash
# Build the backend image, push it, run migrations, then roll out Cloud Run.
# Infra (Cloud SQL, service, job, secrets) comes from infra/terraform; run `terraform apply` first.
#
# Usage (from anywhere):  PROJECT_ID=my-project backend/deploy.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID, e.g. PROJECT_ID=skilful-scarab-511320-q9}"
REGION="${REGION:-asia-southeast1}"
TAG="${TAG:-$(git rev-parse --short HEAD)-$(date +%Y%m%d%H%M%S)}"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/exportmate/backend:$TAG"

cd "$(dirname "$0")"

echo "==> Building $IMAGE"
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet
docker build --platform linux/amd64 -t "$IMAGE" .
docker push "$IMAGE"

echo "==> Running migrations and loading reference data (markets, checklists, ...)"
# The job runs `sh -c "<args>"`. The reference seed is idempotent: it updates rows in place.
gcloud run jobs update exportmate-backend-task \
  --project "$PROJECT_ID" --region "$REGION" --image "$IMAGE" \
  --args="alembic upgrade head && python -m app.seed_reference_data"
gcloud run jobs execute exportmate-backend-task --project "$PROJECT_ID" --region "$REGION" --wait

echo "==> Deploying service"
gcloud run services update exportmate-backend --project "$PROJECT_ID" --region "$REGION" --image "$IMAGE"

URL="$(gcloud run services describe exportmate-backend --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
echo "==> Done: $URL/api/v1/health"
