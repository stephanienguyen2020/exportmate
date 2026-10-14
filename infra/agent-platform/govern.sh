#!/usr/bin/env bash
# Govern the assistant's agents on Agent Platform. Idempotent; run by someone who can set IAM on
# the project (the owner), after ai/server/platform/runtime.py deploy has created the instance.
#
# Usage:  PROJECT_ID=skilful-scarab-511320-q9 RUNTIME=projects/…/reasoningEngines/… infra/agent-platform/govern.sh
#
# 1. Agent Identity: the agents run as their own identity (no service-account keys). It gets only
#    what the agents use: Firestore (stock, alerts, audits, sessions map, answer cache, RAG file
#    records), Agent Platform (Gemini, RAG Engine retrieval, Sessions, Memory Bank) and writing
#    logs and traces.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
RUNTIME="${RUNTIME:?Set RUNTIME to the reasoning engine resource name (platform/runtime.py show)}"
NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
LOCATION="$(cut -d/ -f4 <<<"$RUNTIME")"
ENGINE="$(cut -d/ -f6 <<<"$RUNTIME")"
AGENT="principal://agents.global.proj-${NUMBER}.system.id.goog/resources/aiplatform/projects/${NUMBER}/locations/${LOCATION}/reasoningEngines/${ENGINE}"

echo "==> Agent Identity roles for ${AGENT}"
for role in roles/datastore.user roles/aiplatform.user roles/logging.logWriter roles/cloudtrace.agent; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="$AGENT" --role="$role" --condition=None --quiet >/dev/null
  echo "    $role"
done
