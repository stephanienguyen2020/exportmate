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

# 2. Agent Registry: every endpoint the agents call. (Agent Runtime instances are listed as agents
#    automatically.) Agent Gateway only lets the agents reach what is registered here and allowed
#    by IAM (3). Service ids are 4-63 characters.
REGISTRY_LOCATION="${REGISTRY_LOCATION:-$LOCATION}"
register() { # id url kind
  local id="$1" url="$2" kind="$3"
  if gcloud agent-registry services describe "$id" --location="$REGISTRY_LOCATION" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "    $id (registered)"
    return
  fi
  gcloud agent-registry services create "$id" --location="$REGISTRY_LOCATION" --project="$PROJECT_ID" \
    --display-name="$id" "--${kind}-spec-type=no-spec" --interfaces="url=${url},protocolBinding=http-json" --quiet >/dev/null
  echo "    $id → $url"
}

echo "==> Agent Registry (${REGISTRY_LOCATION})"
# Hostnames are matched exactly, so the regional and mTLS forms are registered too.
ENDPOINTS=(
  "gemini|https://aiplatform.googleapis.com"
  "gemini-mtls|https://aiplatform.mtls.googleapis.com"
  "agent-platform-${LOCATION}|https://${LOCATION}-aiplatform.googleapis.com"
  "agent-platform-${LOCATION}-mtls|https://${LOCATION}-aiplatform.mtls.googleapis.com"
  "agent-platform-${LOCATION}-rep|https://aiplatform.${LOCATION}.rep.googleapis.com"
  "firestore|https://firestore.googleapis.com"
  "firestore-mtls|https://firestore.mtls.googleapis.com"
  "oauth2|https://oauth2.googleapis.com"
  "token-exchange|https://sts.googleapis.com"
  "iam-credentials|https://iamcredentials.googleapis.com"
  "logging|https://logging.googleapis.com"
  "cloud-trace|https://cloudtrace.googleapis.com"
  "telemetry|https://telemetry.googleapis.com"
  "monitoring|https://monitoring.googleapis.com"
  "agent-registry|https://agentregistry.googleapis.com"
)
# The company backend (orders and playbook, with the user's own token), when it is deployed.
[[ -n "${BACKEND_URL:-}" ]] && ENDPOINTS+=("exportmate-backend|${BACKEND_URL}")
for entry in "${ENDPOINTS[@]}"; do register "${entry%%|*}" "${entry#*|}" endpoint; done

# 3. IAM agent policy: the agents may reach each registered endpoint and nothing else
#    (roles/iap.egressor on the endpoint, for the agent identity only). Enforced by the gateway (4).
echo "==> Egress allowed for the agent identity"
POLICY="$(mktemp)"
# (cleaned up with the gateway files below)
printf '{"bindings":[{"role":"roles/iap.egressor","members":["%s"]}]}' "$AGENT" >"$POLICY"
for entry in "${ENDPOINTS[@]}"; do
  name="${entry%%|*}"
  id="$(gcloud agent-registry endpoints list --location="$REGISTRY_LOCATION" --project="$PROJECT_ID" --filter="displayName=${name}" --format='value(name.basename())' | head -1)"
  [[ -z "$id" ]] && { echo "    $name: not in the registry yet, skipped"; continue; }
  gcloud iap web set-iam-policy "$POLICY" --project="$PROJECT_ID" --resource-type=agent-registry --endpoint="$id" --region="$REGISTRY_LOCATION" --quiet >/dev/null
  echo "    $name"
done

# 4. Agent Gateway (egress, Agent-to-Anywhere) reading this registry, with two authorization
#    policies: IAP checks the egress IAM of (3), Model Armor screens JSON and text traffic for prompt
#    injection and jailbreaks. Both start in observe mode (IAM DRY_RUN, Model Armor INSPECT_ONLY):
#    decisions are logged, nothing is blocked. Run again with ENFORCE=1 once the logs are clean.
GATEWAY="${GATEWAY:-exportmate-egress}"
GATEWAY_PATH="projects/${PROJECT_ID}/locations/${LOCATION}/agentGateways/${GATEWAY}"
TEMPLATE="${MODEL_ARMOR_TEMPLATE:-exportmate-agent-traffic}"
TEMPLATE_PATH="projects/${PROJECT_ID}/locations/${LOCATION}/templates/${TEMPLATE}"
ENFORCE="${ENFORCE:-0}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK" "$POLICY"' EXIT

echo "==> Agent Gateway ${GATEWAY} (${LOCATION}), enforce=${ENFORCE}"
cat >"$WORK/gateway.yaml" <<YAML
name: ${GATEWAY}
protocols:
  - MCP
googleManaged:
  governedAccessPath: AGENT_TO_ANYWHERE
registries:
  - //agentregistry.googleapis.com/projects/${PROJECT_ID}/locations/${REGISTRY_LOCATION}
YAML
gcloud network-services agent-gateways import "$GATEWAY" --source="$WORK/gateway.yaml" --location="$LOCATION" --project="$PROJECT_ID" --quiet >/dev/null
echo "    gateway"

cat >"$WORK/iap-ext.yaml" <<YAML
name: ${GATEWAY}-iap
service: iap.googleapis.com
failOpen: false
timeout: 1s
metadata:
  iapPolicyVersion: "V2"
$([[ "$ENFORCE" == 1 ]] || echo '  iamEnforcementMode: "DRY_RUN"')
YAML
gcloud beta service-extensions authz-extensions import "${GATEWAY}-iap" --source="$WORK/iap-ext.yaml" --location="$LOCATION" --project="$PROJECT_ID" --quiet >/dev/null
cat >"$WORK/iap-policy.yaml" <<YAML
name: ${GATEWAY}-iap
target:
  resources:
    - "${GATEWAY_PATH}"
policyProfile: REQUEST_AUTHZ
action: CUSTOM
customProvider:
  authzExtension:
    resources:
      - "projects/${PROJECT_ID}/locations/${LOCATION}/authzExtensions/${GATEWAY}-iap"
YAML
gcloud network-security authz-policies import "${GATEWAY}-iap" --source="$WORK/iap-policy.yaml" --location="$LOCATION" --project="$PROJECT_ID" --quiet >/dev/null
echo "    IAP egress policy ($([[ "$ENFORCE" == 1 ]] && echo enforced || echo DRY_RUN))"

# Model Armor template for agent traffic. (The malicious-URL filter isn't offered in every region.)
TOKEN="$(gcloud auth print-access-token)"
MA="https://modelarmor.${LOCATION}.rep.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/templates"
BODY="{\"filterConfig\":{\"piAndJailbreakFilterSettings\":{\"filterEnforcement\":\"ENABLED\",\"confidenceLevel\":\"MEDIUM_AND_ABOVE\"}},\"templateMetadata\":{\"enforcementType\":\"$([[ "$ENFORCE" == 1 ]] && echo INSPECT_AND_BLOCK || echo INSPECT_ONLY)\",\"logTemplateOperations\":true,\"logSanitizeOperations\":true}}"
if curl -sf -H "Authorization: Bearer $TOKEN" "$MA/$TEMPLATE" >/dev/null; then
  curl -sf -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$MA/$TEMPLATE?updateMask=filterConfig,templateMetadata" -d "$BODY" >/dev/null
else
  curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$MA?templateId=$TEMPLATE" -d "$BODY" >/dev/null
fi
cat >"$WORK/ma-ext.yaml" <<YAML
name: ${GATEWAY}-model-armor
service: modelarmor.${LOCATION}.rep.googleapis.com
metadata:
  model_armor_settings: '[{"response_template_id": "${TEMPLATE_PATH}", "request_template_id": "${TEMPLATE_PATH}"}]'
failOpen: false
timeout: 1s
YAML
gcloud service-extensions authz-extensions import "${GATEWAY}-model-armor" --source="$WORK/ma-ext.yaml" --location="$LOCATION" --project="$PROJECT_ID" --quiet >/dev/null
cat >"$WORK/ma-policy.yaml" <<YAML
name: ${GATEWAY}-model-armor
target:
  resources:
    - "${GATEWAY_PATH}"
policyProfile: CONTENT_AUTHZ
action: CUSTOM
customProvider:
  authzExtension:
    resources:
      - "projects/${PROJECT_ID}/locations/${LOCATION}/authzExtensions/${GATEWAY}-model-armor"
httpRules:
  - when: "request.headers['content-type'].startsWith('application/json') || request.headers['content-type'].startsWith('text/')"
YAML
gcloud network-security authz-policies import "${GATEWAY}-model-armor" --source="$WORK/ma-policy.yaml" --location="$LOCATION" --project="$PROJECT_ID" --quiet >/dev/null
echo "    Model Armor ${TEMPLATE} ($([[ "$ENFORCE" == 1 ]] && echo inspect and block || echo inspect only))"

# The gateway calls Model Armor as its own service account.
GATEWAY_SA="$(gcloud network-services agent-gateways describe "$GATEWAY" --location="$LOCATION" --project="$PROJECT_ID" --format='value(agentGatewayCard.serviceExtensionsServiceAccount)')"
for role in roles/modelarmor.calloutUser roles/serviceusage.serviceUsageConsumer roles/modelarmor.user; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${GATEWAY_SA}" --role="$role" --condition=None --quiet >/dev/null
done
echo "    gateway service account ${GATEWAY_SA}: Model Armor roles"

# 5. Bind the agents to the gateway (also installs its root CA in the container):
echo "==> Next: uv run --project ai/server/platform python ai/server/platform/runtime.py deploy --image … --gateway ${GATEWAY_PATH}"
