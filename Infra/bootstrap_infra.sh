#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-skitkerline}"
PROJECT_NUMBER="${PROJECT_NUMBER:-917214899974}"
REGION="${REGION:-asia-southeast1}"
ARTIFACT_REPO="${ARTIFACT_REPO:-stickerline}"
GCS_BUCKET_NAME="${GCS_BUCKET_NAME:-skitkerline_stickerline}"

BE_SERVICE="${BE_SERVICE:-stickerline-be}"
WORKER_SERVICE="${WORKER_SERVICE:-stickerline-worker}"
WORKER_URL="${WORKER_URL:-}"

BE_SA="${BE_SA:-stickerline-be-sa@${PROJECT_ID}.iam.gserviceaccount.com}"
WORKER_SA="${WORKER_SA:-stickerline-worker-sa@${PROJECT_ID}.iam.gserviceaccount.com}"
PUBSUB_INVOKER_SA="${PUBSUB_INVOKER_SA:-stickerline-pubsub-invoker@${PROJECT_ID}.iam.gserviceaccount.com}"
PUBSUB_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"
DEPLOYER_EMAIL="${DEPLOYER_EMAIL:-chonlathan@manee-son.com}"

STICKER_GENERATION_TOPIC="${STICKER_GENERATION_TOPIC:-sticker-generation-jobs}"
STICKER_GENERATION_SUBSCRIPTION="${STICKER_GENERATION_SUBSCRIPTION:-sticker-generation-jobs-worker-push}"
STICKER_GENERATION_DLQ_TOPIC="${STICKER_GENERATION_DLQ_TOPIC:-sticker-generation-jobs-dlq}"
STICKER_GENERATION_DLQ_SUB="${STICKER_GENERATION_DLQ_SUB:-sticker-generation-jobs-dlq-sub}"
PUBSUB_ACK_DEADLINE_SECONDS="${PUBSUB_ACK_DEADLINE_SECONDS:-600}"
PUBSUB_MIN_RETRY_DELAY="${PUBSUB_MIN_RETRY_DELAY:-60s}"
PUBSUB_MAX_RETRY_DELAY="${PUBSUB_MAX_RETRY_DELAY:-600s}"
PUBSUB_MAX_DELIVERY_ATTEMPTS="${PUBSUB_MAX_DELIVERY_ATTEMPTS:-5}"
PUBSUB_MESSAGE_RETENTION_DURATION="${PUBSUB_MESSAGE_RETENTION_DURATION:-7d}"

ALERT_EMAIL="${ALERT_EMAIL:-chonlathan@manee-son.com}"
CREATE_MONITORING_CHANNEL="${CREATE_MONITORING_CHANNEL:-0}"
CREATE_ALERT_POLICIES="${CREATE_ALERT_POLICIES:-0}"
ALERT_POLICY_PREFIX="${ALERT_POLICY_PREFIX:-StickerLine}"
ALERT_DLQ_UNDELIVERED_THRESHOLD="${ALERT_DLQ_UNDELIVERED_THRESHOLD:-0}"
ALERT_OLDEST_UNACKED_AGE_SECONDS="${ALERT_OLDEST_UNACKED_AGE_SECONDS:-300}"
ALERT_WORKER_5XX_RATE_THRESHOLD="${ALERT_WORKER_5XX_RATE_THRESHOLD:-0}"
GRANT_GEMINI_TO_BE="${GRANT_GEMINI_TO_BE:-0}"

LINE_CHANNEL_SECRET_NAME="${LINE_CHANNEL_SECRET_NAME:-line-channel-secret}"
BEAM_MERCHANT_ID_SECRET_NAME="${BEAM_MERCHANT_ID_SECRET_NAME:-beam-merchant-id}"
BEAM_API_KEY_SECRET_NAME="${BEAM_API_KEY_SECRET_NAME:-beam-api-key}"
BEAM_WEBHOOK_HMAC_KEY_SECRET_NAME="${BEAM_WEBHOOK_HMAC_KEY_SECRET_NAME:-beam-webhook-hmac-key}"
GEMINI_API_KEY_SECRET_NAME="${GEMINI_API_KEY_SECRET_NAME:-gemini-api-key}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: Missing required command: $1" >&2
    exit 1
  fi
}

service_account_id() {
  local email="$1"
  printf "%s" "${email%@*}"
}

ensure_service_account() {
  local email="$1"
  local display_name="$2"
  local account_id
  account_id="$(service_account_id "${email}")"

  if gcloud iam service-accounts describe "${email}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    echo "OK service account exists: ${email}"
    return
  fi

  echo "==> Create service account: ${email}"
  gcloud iam service-accounts create "${account_id}" \
    --project "${PROJECT_ID}" \
    --display-name "${display_name}" \
    --quiet
}

ensure_project_role() {
  local member="$1"
  local role="$2"
  echo "==> Grant ${role} to ${member}"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "${member}" \
    --role "${role}" \
    --condition=None \
    --quiet >/dev/null
}

ensure_service_account_role() {
  local service_account="$1"
  local member="$2"
  local role="$3"
  echo "==> Grant ${role} on ${service_account} to ${member}"
  gcloud iam service-accounts add-iam-policy-binding "${service_account}" \
    --project "${PROJECT_ID}" \
    --member "${member}" \
    --role "${role}" \
    --quiet >/dev/null
}

ensure_secret_access() {
  local secret_name="$1"
  local service_account="$2"

  if ! gcloud secrets describe "${secret_name}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    echo "WARNING: Secret Manager secret not found: ${secret_name}. Create it before deploying services."
    return
  fi

  echo "==> Grant secretAccessor on ${secret_name} to ${service_account}"
  gcloud secrets add-iam-policy-binding "${secret_name}" \
    --project "${PROJECT_ID}" \
    --member "serviceAccount:${service_account}" \
    --role "roles/secretmanager.secretAccessor" \
    --quiet >/dev/null
}

ensure_topic() {
  local topic="$1"
  if gcloud pubsub topics describe "${topic}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    echo "OK topic exists: ${topic}"
    return
  fi

  echo "==> Create Pub/Sub topic: ${topic}"
  gcloud pubsub topics create "${topic}" --project "${PROJECT_ID}" --quiet
}

ensure_subscription() {
  local subscription="$1"
  local topic="$2"
  shift 2

  if gcloud pubsub subscriptions describe "${subscription}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    echo "==> Update Pub/Sub subscription: ${subscription}"
    gcloud pubsub subscriptions update "${subscription}" \
      --project "${PROJECT_ID}" \
      "$@" \
      --quiet
    return
  fi

  echo "==> Create Pub/Sub subscription: ${subscription}"
  gcloud pubsub subscriptions create "${subscription}" \
    --project "${PROJECT_ID}" \
    --topic "${topic}" \
    "$@" \
    --quiet
}

ensure_topic_role() {
  local topic="$1"
  local member="$2"
  local role="$3"
  echo "==> Grant ${role} on topic ${topic} to ${member}"
  gcloud pubsub topics add-iam-policy-binding "${topic}" \
    --project "${PROJECT_ID}" \
    --member "${member}" \
    --role "${role}" \
    --quiet >/dev/null
}

ensure_subscription_role() {
  local subscription="$1"
  local member="$2"
  local role="$3"
  echo "==> Grant ${role} on subscription ${subscription} to ${member}"
  gcloud pubsub subscriptions add-iam-policy-binding "${subscription}" \
    --project "${PROJECT_ID}" \
    --member "${member}" \
    --role "${role}" \
    --quiet >/dev/null
}

ensure_worker_invoker() {
  if ! gcloud run services describe "${WORKER_SERVICE}" --project "${PROJECT_ID}" --region "${REGION}" >/dev/null 2>&1; then
    echo "WARNING: Cloud Run worker service does not exist yet: ${WORKER_SERVICE}. Run backend_stickerline-worker.sh, then rerun this bootstrap."
    return
  fi

  echo "==> Grant run.invoker on ${WORKER_SERVICE} to ${PUBSUB_INVOKER_SA}"
  gcloud run services add-iam-policy-binding "${WORKER_SERVICE}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --member "serviceAccount:${PUBSUB_INVOKER_SA}" \
    --role "roles/run.invoker" \
    --quiet >/dev/null
}

resolve_worker_url() {
  if [[ -n "${WORKER_URL}" ]]; then
    printf "%s" "${WORKER_URL}"
    return
  fi

  gcloud run services describe "${WORKER_SERVICE}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --format "value(status.url)" 2>/dev/null || true
}

ensure_artifact_repo() {
  if gcloud artifacts repositories describe "${ARTIFACT_REPO}" --project "${PROJECT_ID}" --location "${REGION}" >/dev/null 2>&1; then
    echo "OK Artifact Registry repo exists: ${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}"
    return
  fi

  echo "==> Create Artifact Registry Docker repo: ${ARTIFACT_REPO}"
  gcloud artifacts repositories create "${ARTIFACT_REPO}" \
    --project "${PROJECT_ID}" \
    --location "${REGION}" \
    --repository-format docker \
    --description "StickerLine container images" \
    --quiet
}

ensure_monitoring_channel() {
  MONITORING_NOTIFICATION_CHANNEL=""

  if [[ "${CREATE_MONITORING_CHANNEL}" != "1" && "${CREATE_ALERT_POLICIES}" != "1" ]]; then
    echo "SKIP monitoring notification channel. Set CREATE_MONITORING_CHANNEL=1 or CREATE_ALERT_POLICIES=1 to create an email channel for ${ALERT_EMAIL}."
    return
  fi

  local existing_channel
  existing_channel="$(gcloud alpha monitoring channels list \
    --project "${PROJECT_ID}" \
    --filter "type=email AND labels.email_address=${ALERT_EMAIL}" \
    --format "value(name)" 2>/dev/null | head -n 1 || true)"

  if [[ -n "${existing_channel}" ]]; then
    echo "OK monitoring email channel exists: ${existing_channel}"
    MONITORING_NOTIFICATION_CHANNEL="${existing_channel}"
    return
  fi

  echo "==> Create monitoring email channel for ${ALERT_EMAIL}"
  MONITORING_NOTIFICATION_CHANNEL="$(gcloud alpha monitoring channels create \
    --project "${PROJECT_ID}" \
    --display-name "StickerLine alerts ${ALERT_EMAIL}" \
    --type email \
    --channel-labels "email_address=${ALERT_EMAIL}" \
    --format "value(name)" \
    --quiet)"
}

policy_exists() {
  local display_name="$1"
  gcloud alpha monitoring policies list \
    --project "${PROJECT_ID}" \
    --filter "displayName=\"${display_name}\"" \
    --format "value(name)" 2>/dev/null | grep -q .
}

create_threshold_alert_policy_if_missing() {
  local display_name="$1"
  local condition_display_name="$2"
  local metric_filter="$3"
  local threshold_value="$4"
  local duration="$5"
  local aligner="$6"
  local reducer="$7"
  local documentation="$8"

  if policy_exists "${display_name}"; then
    echo "OK alert policy exists: ${display_name}"
    return
  fi

  local aggregation
  aggregation="{\"alignmentPeriod\":\"60s\",\"perSeriesAligner\":\"${aligner}\",\"crossSeriesReducer\":\"${reducer}\",\"groupByFields\":[]}"

  local create_args=(
    --project "${PROJECT_ID}"
    --display-name "${display_name}"
    --condition-display-name "${condition_display_name}"
    --condition-filter "${metric_filter}"
    --if "> ${threshold_value}"
    --duration "${duration}"
    --trigger-count 1
    --combiner OR
    --aggregation "${aggregation}"
    --documentation "${documentation}"
    --quiet
  )

  if [[ -n "${MONITORING_NOTIFICATION_CHANNEL:-}" ]]; then
    create_args+=(--notification-channels "${MONITORING_NOTIFICATION_CHANNEL}")
  fi

  echo "==> Create alert policy: ${display_name}"
  gcloud alpha monitoring policies create "${create_args[@]}" >/dev/null
}

ensure_alert_policies() {
  if [[ "${CREATE_ALERT_POLICIES}" != "1" ]]; then
    echo "SKIP alert policies. Set CREATE_ALERT_POLICIES=1 to create initial Monitoring alerts."
    return
  fi

  local dlq_policy="${ALERT_POLICY_PREFIX} DLQ has messages"
  local oldest_policy="${ALERT_POLICY_PREFIX} generation queue oldest unacked age high"
  local worker_5xx_policy="${ALERT_POLICY_PREFIX} worker 5xx responses"

  create_threshold_alert_policy_if_missing \
    "${dlq_policy}" \
    "DLQ undelivered messages > ${ALERT_DLQ_UNDELIVERED_THRESHOLD}" \
    "resource.type = \"pubsub_subscription\" AND resource.labels.subscription_id = \"${STICKER_GENERATION_DLQ_SUB}\" AND metric.type = \"pubsub.googleapis.com/subscription/num_undelivered_messages\"" \
    "${ALERT_DLQ_UNDELIVERED_THRESHOLD}" \
    "60s" \
    "ALIGN_MAX" \
    "REDUCE_MAX" \
    "DLQ subscription has undelivered messages. Inspect ${STICKER_GENERATION_DLQ_SUB}, worker logs, and failed jobs before acknowledging or replaying messages."

  create_threshold_alert_policy_if_missing \
    "${oldest_policy}" \
    "Oldest unacked generation message age > ${ALERT_OLDEST_UNACKED_AGE_SECONDS}s" \
    "resource.type = \"pubsub_subscription\" AND resource.labels.subscription_id = \"${STICKER_GENERATION_SUBSCRIPTION}\" AND metric.type = \"pubsub.googleapis.com/subscription/oldest_unacked_message_age\"" \
    "${ALERT_OLDEST_UNACKED_AGE_SECONDS}" \
    "300s" \
    "ALIGN_MAX" \
    "REDUCE_MAX" \
    "Generation queue oldest unacked message age is high. Check worker scaling, AI latency, failures, and Pub/Sub backlog."

  create_threshold_alert_policy_if_missing \
    "${worker_5xx_policy}" \
    "Worker 5xx response rate > ${ALERT_WORKER_5XX_RATE_THRESHOLD}" \
    "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${WORKER_SERVICE}\" AND resource.labels.location = \"${REGION}\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\"" \
    "${ALERT_WORKER_5XX_RATE_THRESHOLD}" \
    "60s" \
    "ALIGN_RATE" \
    "REDUCE_SUM" \
    "Cloud Run worker is returning 5xx responses. Check stickerline-worker logs and Pub/Sub retry/DLQ state."
}

require_command gcloud

echo "==> Set gcloud project"
gcloud config set project "${PROJECT_ID}" >/dev/null

echo "==> Enable required services"
gcloud services enable \
  artifactregistry.googleapis.com \
  aiplatform.googleapis.com \
  cloudbuild.googleapis.com \
  firestore.googleapis.com \
  iam.googleapis.com \
  monitoring.googleapis.com \
  pubsub.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  --project "${PROJECT_ID}" \
  --quiet

ensure_artifact_repo

ensure_service_account "${BE_SA}" "StickerLine backend runtime"
ensure_service_account "${WORKER_SA}" "StickerLine worker runtime"
ensure_service_account "${PUBSUB_INVOKER_SA}" "StickerLine Pub/Sub push invoker"

ensure_project_role "serviceAccount:${BE_SA}" "roles/datastore.user"
ensure_project_role "serviceAccount:${BE_SA}" "roles/storage.objectAdmin"
ensure_project_role "serviceAccount:${BE_SA}" "roles/logging.logWriter"

ensure_project_role "serviceAccount:${WORKER_SA}" "roles/datastore.user"
ensure_project_role "serviceAccount:${WORKER_SA}" "roles/storage.objectAdmin"
ensure_project_role "serviceAccount:${WORKER_SA}" "roles/aiplatform.user"
ensure_project_role "serviceAccount:${WORKER_SA}" "roles/logging.logWriter"

ensure_topic "${STICKER_GENERATION_TOPIC}"
ensure_topic "${STICKER_GENERATION_DLQ_TOPIC}"
ensure_topic_role "${STICKER_GENERATION_TOPIC}" "serviceAccount:${BE_SA}" "roles/pubsub.publisher"
ensure_topic_role "${STICKER_GENERATION_DLQ_TOPIC}" "serviceAccount:${PUBSUB_SERVICE_AGENT}" "roles/pubsub.publisher"

ensure_secret_access "${LINE_CHANNEL_SECRET_NAME}" "${BE_SA}"
ensure_secret_access "${BEAM_MERCHANT_ID_SECRET_NAME}" "${BE_SA}"
ensure_secret_access "${BEAM_API_KEY_SECRET_NAME}" "${BE_SA}"
ensure_secret_access "${BEAM_WEBHOOK_HMAC_KEY_SECRET_NAME}" "${BE_SA}"
if [[ "${GRANT_GEMINI_TO_BE}" == "1" ]]; then
  ensure_secret_access "${GEMINI_API_KEY_SECRET_NAME}" "${BE_SA}"
fi

ensure_secret_access "${LINE_CHANNEL_SECRET_NAME}" "${WORKER_SA}"
ensure_secret_access "${GEMINI_API_KEY_SECRET_NAME}" "${WORKER_SA}"

ensure_service_account_role "${PUBSUB_INVOKER_SA}" "serviceAccount:${PUBSUB_SERVICE_AGENT}" "roles/iam.serviceAccountTokenCreator"
if [[ -n "${DEPLOYER_EMAIL}" ]]; then
  ensure_service_account_role "${BE_SA}" "user:${DEPLOYER_EMAIL}" "roles/iam.serviceAccountUser"
  ensure_service_account_role "${WORKER_SA}" "user:${DEPLOYER_EMAIL}" "roles/iam.serviceAccountUser"
fi

ensure_subscription "${STICKER_GENERATION_DLQ_SUB}" "${STICKER_GENERATION_DLQ_TOPIC}" \
  --message-retention-duration "${PUBSUB_MESSAGE_RETENTION_DURATION}"

worker_url="$(resolve_worker_url)"
if [[ -z "${worker_url}" ]]; then
  echo "WARNING: Worker URL is not available yet. Skipping push subscription create/update."
  echo "Run backend_stickerline-worker.sh first, then rerun this script or pass WORKER_URL=https://..."
else
  ensure_worker_invoker
  push_endpoint="${worker_url%/}/pubsub/push"
  ensure_subscription "${STICKER_GENERATION_SUBSCRIPTION}" "${STICKER_GENERATION_TOPIC}" \
    --push-endpoint "${push_endpoint}" \
    --push-auth-service-account "${PUBSUB_INVOKER_SA}" \
    --ack-deadline "${PUBSUB_ACK_DEADLINE_SECONDS}" \
    --min-retry-delay "${PUBSUB_MIN_RETRY_DELAY}" \
    --max-retry-delay "${PUBSUB_MAX_RETRY_DELAY}" \
    --dead-letter-topic "${STICKER_GENERATION_DLQ_TOPIC}" \
    --dead-letter-topic-project "${PROJECT_ID}" \
    --max-delivery-attempts "${PUBSUB_MAX_DELIVERY_ATTEMPTS}" \
    --message-retention-duration "${PUBSUB_MESSAGE_RETENTION_DURATION}"
  ensure_subscription_role "${STICKER_GENERATION_SUBSCRIPTION}" "serviceAccount:${PUBSUB_SERVICE_AGENT}" "roles/pubsub.subscriber"
fi

ensure_monitoring_channel
ensure_alert_policies

cat <<EOF

Bootstrap complete.

Next:
1. Deploy worker:
   ./backend_stickerline-worker.sh
2. Rerun bootstrap to bind run.invoker and create/update the push subscription:
   ./Infra/bootstrap_infra.sh
3. Deploy backend in local_async mode, test, then switch with:
   GENERATION_DISPATCH_MODE=pubsub ./backend_stickerline-be.sh
EOF
