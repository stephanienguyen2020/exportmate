#!/usr/bin/env bash
# Copy the trade risk data and the trained model to the ML bucket (infra/terraform/trade_risk.tf),
# where the Order features job reads them. Run once after `terraform apply`, and again after
# preparing new data (`trade_risk.cases`, `trade_risk.trade_flows`) or training a new model
# (`trade_risk.final_model`). Only changed files are copied.
#
# Usage (from anywhere):  PROJECT_ID=my-project ml/upload.sh
# The data can live elsewhere: ML_DATA_DIR=/path/to/ml/data (as for the Python code).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID, e.g. PROJECT_ID=skilful-scarab-511320-q9}"
BUCKET="${BUCKET:-gs://exportmate-ml-dev}"

cd "$(dirname "$0")"
DATA="${ML_DATA_DIR:-data}"
MODELS="${ML_MODELS_DIR:-models}"

# What the job reads: the prepared tables (cases.parquet, trade_flows.parquet,
# exporter_totals.parquet), the HS conversion tables and BACI's country codes (inside its zip),
# and the saved models. The other prepared tables (features, test predictions) come along for
# training later.
echo "==> Prepared tables"
gcloud storage rsync --project "$PROJECT_ID" --recursive \
  "$DATA/interim/trade_risk" "$BUCKET/data/interim/trade_risk"

# The raw sources too (BACI, TTBD, Federal Register notices, HS conversion tables): the job needs
# the conversion tables and BACI's zip, and training can run from them later.
for source in baci ttbd federal_register concordance; do
  echo "==> Raw $source"
  gcloud storage rsync --project "$PROJECT_ID" --recursive \
    "$DATA/raw/$source" "$BUCKET/data/raw/$source"
done

echo "==> Models"
gcloud storage rsync --project "$PROJECT_ID" --recursive \
  "$MODELS/trade_risk" "$BUCKET/models/trade_risk"
# The harshness model (`harshness final`), which scores the news scan's trade measures.
if [ -d "$MODELS/harshness" ]; then
  gcloud storage rsync --project "$PROJECT_ID" --recursive \
    "$MODELS/harshness" "$BUCKET/models/harshness"
fi

echo "==> Done: $BUCKET"
