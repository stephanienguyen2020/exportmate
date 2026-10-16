#!/usr/bin/env bash
# Monitoring for one ExportMate service: log-based metrics, an email channel, an uptime check,
# alert policies and a dashboard, from the JSON files in ai/ or backend/. Safe to run again:
# each item is found by its name and updated in place.
#
#   PROJECT_ID=exportmate-app PART=ai SERVICE=exportmate-ai ALERT_EMAIL=you@example.com ./apply.sh
#   PROJECT_ID=skilful-scarab-511320-q9 PART=backend SERVICE=exportmate-backend \
#     WEBSITE_HOST=exportmate.vercel.app ALERT_EMAIL=you@example.com ./apply.sh
#
# The AI part's uptime check calls the Cloud Run service directly; the backend's goes through the
# website (WEBSITE_HOST), so it also fails when Vercel or its /api/v1 proxy does. Needs
# monitoring and logging write access (Editor is enough). `npm run ops` in ai/server reads the
# same picture from Firestore.
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}" "${PART:?set PART (ai or backend)}" "${SERVICE:?set SERVICE (the Cloud Run service)}" "${ALERT_EMAIL:?set ALERT_EMAIL}"
REGION="${REGION:-asia-southeast1}"
DIR="$(cd "$(dirname "$0")" && pwd)/$PART"
[[ -d "$DIR" ]] || { echo "No monitoring files for PART=$PART" >&2; exit 1; }

if [[ "$PART" == backend ]]; then
  HOST="${WEBSITE_HOST:?set WEBSITE_HOST (the website the backend is reached through)}"
else
  HOST="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)' | sed 's|https://||')"
fi
TOKEN="$(gcloud auth print-access-token)"
LOGGING="https://logging.googleapis.com/v2/projects/$PROJECT_ID"
MONITORING="https://monitoring.googleapis.com/v3/projects/$PROJECT_ID"
DASHBOARDS="https://monitoring.googleapis.com/v1/projects/$PROJECT_ID/dashboards"

# api METHOD URL [BODY]: prints the response; stops the script on an HTTP error.
api() {
  local out code args=(-sS -X "$1" "$2" -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT_ID" -H "Content-Type: application/json")
  [[ $# -ge 3 ]] && args+=(--data-binary "$3")
  out="$(curl "${args[@]}" -w $'\n%{http_code}')"
  code="${out##*$'\n'}"
  out="${out%$'\n'*}"
  if [[ "$code" -ge 400 ]]; then echo "$1 $2 -> $code: $out" >&2; return 1; fi
  printf '%s' "$out"
}

# The files' placeholders, filled in.
fill() {
  sed -e "s|\${PROJECT_ID}|$PROJECT_ID|g" -e "s|\${SERVICE}|$SERVICE|g" -e "s|\${HOST}|$HOST|g" \
    -e "s|\${CHANNEL}|${CHANNEL:-}|g" -e "s|\${UPTIME_ID}|${UPTIME_ID:-}|g" "$1"
}

echo "Log-based metrics"
for f in "$DIR"/metrics/*.json; do
  name="$(jq -r .name "$f")"
  url="$LOGGING/metrics/$(jq -rn --arg s "$name" '$s|@uri')"
  body="$(fill "$f")"
  if api GET "$url" >/dev/null 2>&1; then
    api PUT "$url" "$body" >/dev/null && echo "  updated $name"
  else
    api POST "$LOGGING/metrics" "$body" >/dev/null && echo "  created $name"
  fi
done

echo "Email channel"
CHANNEL="$(api GET "$MONITORING/notificationChannels?filter=$(jq -rn --arg e "$ALERT_EMAIL" '"type=\"email\" AND labels.email_address=\"\($e)\""|@uri')" | jq -r '.notificationChannels[0].name // empty')"
if [[ -z "$CHANNEL" ]]; then
  CHANNEL="$(api POST "$MONITORING/notificationChannels" "$(jq -n --arg e "$ALERT_EMAIL" '{type: "email", displayName: "ExportMate ops (\($e))", labels: {email_address: $e}}')" | jq -r .name)"
  echo "  created $CHANNEL"
else
  echo "  using $CHANNEL"
fi

echo "Uptime check ($HOST)"
uptime_name="$(jq -r .displayName "$DIR/uptime.json")"
existing="$(api GET "$MONITORING/uptimeCheckConfigs" | jq -r --arg n "$uptime_name" '.uptimeCheckConfigs[]? | select(.displayName == $n) | .name' | head -1)"
if [[ -n "$existing" ]]; then
  api PATCH "https://monitoring.googleapis.com/v3/$existing?updateMask=httpCheck,contentMatchers,period,timeout" "$(fill "$DIR/uptime.json")" >/dev/null
  echo "  updated $existing"
else
  existing="$(api POST "$MONITORING/uptimeCheckConfigs" "$(fill "$DIR/uptime.json")" | jq -r .name)"
  echo "  created $existing"
fi
UPTIME_ID="${existing##*/}"

echo "Alert policies"
policies="$(api GET "$MONITORING/alertPolicies?pageSize=200")"
for f in "$DIR"/alerts/*.json; do
  body="$(fill "$f")"
  title="$(jq -r .displayName <<<"$body")"
  name="$(jq -r --arg n "$title" '.alertPolicies[]? | select(.displayName == $n) | .name' <<<"$policies" | head -1)"
  if [[ -n "$name" ]]; then
    api PATCH "https://monitoring.googleapis.com/v3/$name" "$body" >/dev/null && echo "  updated $title"
  else
    api POST "$MONITORING/alertPolicies" "$body" >/dev/null && echo "  created $title"
  fi
done

echo "Dashboard"
body="$(fill "$DIR/dashboard.json")"
title="$(jq -r .displayName <<<"$body")"
existing="$(api GET "$DASHBOARDS?pageSize=100" | jq -r --arg n "$title" '.dashboards[]? | select(.displayName == $n) | .name' | head -1)"
if [[ -n "$existing" ]]; then
  etag="$(api GET "https://monitoring.googleapis.com/v1/$existing" | jq -r .etag)"
  api PATCH "https://monitoring.googleapis.com/v1/$existing" "$(jq --arg e "$etag" '. + {etag: $e}' <<<"$body")" >/dev/null
  echo "  updated $title"
else
  existing="$(api POST "$DASHBOARDS" "$body" | jq -r .name)"
  echo "  created $title"
fi
echo "https://console.cloud.google.com/monitoring/dashboards/builder/${existing##*/}?project=$PROJECT_ID"
