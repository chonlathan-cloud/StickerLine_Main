#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/backend/.env}"

load_env_file() {
  local file_path="$1"
  [[ -f "${file_path}" ]] || return 0

  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line//[[:space:]]/}" ]] && continue
    [[ "${line}" =~ ^[[:space:]]*# ]] && continue

    if [[ "${line}" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[2]}"
      local raw_value="${BASH_REMATCH[3]}"

      if [[ -z "${!key+x}" ]]; then
        local value
        if [[ "${raw_value}" =~ ^\"(.*)\"$ ]]; then
          value="${BASH_REMATCH[1]}"
        elif [[ "${raw_value}" =~ ^\'(.*)\'$ ]]; then
          value="${BASH_REMATCH[1]}"
        else
          value="${raw_value}"
        fi
        export "${key}=${value}"
      fi
    fi
  done < "${file_path}"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: Missing required command: $1" >&2
    exit 1
  fi
}

append_env_var() {
  local key="$1"
  local value="${!key:-}"
  local escaped="${value//\'/\'\'}"
  printf "%s: '%s'\n" "${key}" "${escaped}" >> "${TMP_ENV_VARS_FILE}"
}

join_by_comma() {
  local IFS=","
  printf "%s" "$*"
}

ensure_artifact_repo() {
  if gcloud artifacts repositories describe "${ARTIFACT_REPO}" --project "${PROJECT_ID}" --location "${REGION}" >/dev/null 2>&1; then
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

require_secret_with_enabled_version() {
  local secret_name="$1"
  if ! gcloud secrets describe "${secret_name}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    echo "MISSING_SECRET:${secret_name}"
    return 1
  fi

  if ! gcloud secrets versions list "${secret_name}" \
    --project "${PROJECT_ID}" \
    --filter "state=enabled" \
    --limit 1 \
    --format "value(name)" | grep -q .; then
    echo "MISSING_ENABLED_VERSION:${secret_name}"
    return 1
  fi
}

load_env_file "${ENV_FILE}"
require_command gcloud
require_command docker

PROJECT_ID="${PROJECT_ID:-skitkerline}"
REGION="${REGION:-asia-southeast1}"
ARTIFACT_REPO="${ARTIFACT_REPO:-stickerline}"
SERVICE_NAME="${WORKER_SERVICE:-stickerline-worker}"
IMAGE_NAME="${IMAGE_NAME:-${SERVICE_NAME}}"
RUNTIME_SA="${WORKER_RUNTIME_SA:-stickerline-worker-sa@${PROJECT_ID}.iam.gserviceaccount.com}"

GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
IMAGE="${IMAGE:-${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/${IMAGE_NAME}:${GIT_SHA}}"
BUILD_IMAGE="${BUILD_IMAGE:-1}"
NO_CACHE="${NO_CACHE:-0}"

MEMORY="${MEMORY:-2Gi}"
CPU="${CPU:-1}"
CONCURRENCY="${CONCURRENCY:-1}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"
MAX_INSTANCES="${MAX_INSTANCES:-200}"
TIMEOUT="${TIMEOUT:-600s}"
INGRESS="${INGRESS:-internal}"

GCS_BUCKET_NAME="${GCS_BUCKET_NAME:-skitkerline_stickerline}"
LIFF_CHANNEL_ID="${LIFF_CHANNEL_ID:-}"
BEAM_BASE_URL="${BEAM_BASE_URL:-https://playground.api.beamcheckout.com}"
PAYMENT_REDIRECT_URL="${PAYMENT_REDIRECT_URL:-https://stickerline-fe-917214899974.asia-southeast1.run.app/payment}"
PAYMENT_WEBHOOK_PUBLIC_URL="${PAYMENT_WEBHOOK_PUBLIC_URL:-}"
PAYMENT_LINK_EXPIRY_MINUTES="${PAYMENT_LINK_EXPIRY_MINUTES:-30}"
PAYMENT_CURRENCY="${PAYMENT_CURRENCY:-THB}"
BEAM_ENABLE_CARD="${BEAM_ENABLE_CARD:-true}"
BEAM_ENABLE_CARD_INSTALLMENTS="${BEAM_ENABLE_CARD_INSTALLMENTS:-false}"
BEAM_ENABLE_QR_PROMPTPAY="${BEAM_ENABLE_QR_PROMPTPAY:-true}"
BEAM_ENABLE_EWALLETS="${BEAM_ENABLE_EWALLETS:-false}"
BEAM_ENABLE_MOBILE_BANKING="${BEAM_ENABLE_MOBILE_BANKING:-true}"
BEAM_ENABLE_BNPL="${BEAM_ENABLE_BNPL:-false}"
VERTEX_MODEL="${VERTEX_MODEL:-gemini-3.1-flash-image-preview}"
VERTEX_LOCATION="${VERTEX_LOCATION:-global}"
GENAI_PROVIDER="${GENAI_PROVIDER:-vertex}"
GENAI_MODEL_ROUTING_ENABLED="${GENAI_MODEL_ROUTING_ENABLED:-true}"
PRIMARY_VERTEX_MODEL="${PRIMARY_VERTEX_MODEL:-gemini-3.1-flash-image-preview}"
FALLBACK_VERTEX_MODEL="${FALLBACK_VERTEX_MODEL:-gemini-3-pro-image-preview}"
GENAI_VERTEX_MODEL_ROUTE="${GENAI_VERTEX_MODEL_ROUTE:-}"
GENAI_GEMINI_API_FALLBACK_MODEL="${GENAI_GEMINI_API_FALLBACK_MODEL:-gemini-3-pro-image-preview}"
GENAI_PROMPT_PROFILE="${GENAI_PROMPT_PROFILE:-auto}"
GENAI_QUALITY_ATTEMPTS="${GENAI_QUALITY_ATTEMPTS:-3}"
GENAI_QUALITY_FALLBACK_ENABLED="${GENAI_QUALITY_FALLBACK_ENABLED:-true}"
GEMINI_API_BASE_URL="${GEMINI_API_BASE_URL:-https://generativelanguage.googleapis.com}"
GEMINI_IMAGE_ASPECT_RATIO="${GEMINI_IMAGE_ASPECT_RATIO:-1:1}"
GEMINI_IMAGE_SIZE="${GEMINI_IMAGE_SIZE:-2K}"
GENAI_FALLBACK_PROVIDER="${GENAI_FALLBACK_PROVIDER:-gemini_api}"
GENAI_FALLBACK_MAX_RETRIES="${GENAI_FALLBACK_MAX_RETRIES:-2}"
LINE_PROFILE_CACHE_TTL_SECONDS="${LINE_PROFILE_CACHE_TTL_SECONDS:-300}"
LINE_PROFILE_CACHE_GRACE_SECONDS="${LINE_PROFILE_CACHE_GRACE_SECONDS:-600}"
LINE_PROFILE_REQUEST_TIMEOUT="${LINE_PROFILE_REQUEST_TIMEOUT:-10.0}"
LINE_PROFILE_REQUEST_RETRIES="${LINE_PROFILE_REQUEST_RETRIES:-1}"
LINE_PROFILE_RETRY_DELAY="${LINE_PROFILE_RETRY_DELAY:-0.5}"
CORS_ALLOWED_ORIGINS="${CORS_ALLOWED_ORIGINS:-http://localhost:3000,http://localhost:3002,https://stickerline-fe-917214899974.asia-southeast1.run.app,https://stickerline-fe-to5rvfgg5a-as.a.run.app}"
CORS_ALLOW_ORIGIN_REGEX="${CORS_ALLOW_ORIGIN_REGEX:-^https://stickerline-fe-[a-z0-9-]+\\.a\\.run\\.app$}"
GENERATION_DISPATCH_MODE="pubsub"
GENERATION_CONCURRENCY="${GENERATION_CONCURRENCY:-1}"
GENERATION_COOLDOWN_SECONDS="${GENERATION_COOLDOWN_SECONDS:-30}"
GENERATION_MAX_RETRIES="${GENERATION_MAX_RETRIES:-8}"
GENERATION_RETRY_BASE_DELAY="${GENERATION_RETRY_BASE_DELAY:-5.0}"
GENERATION_ATTEMPT_RESERVATION_RETRIES="${GENERATION_ATTEMPT_RESERVATION_RETRIES:-3}"
GENERATION_ATTEMPT_RESERVATION_RETRY_BASE_DELAY="${GENERATION_ATTEMPT_RESERVATION_RETRY_BASE_DELAY:-0.2}"
FIRESTORE_TRANSACTION_MAX_ATTEMPTS="${FIRESTORE_TRANSACTION_MAX_ATTEMPTS:-10}"
AI_PROVIDER_MAX_CONCURRENT_CALLS="${AI_PROVIDER_MAX_CONCURRENT_CALLS:-8}"
AI_PROVIDER_CAPACITY_LEASE_SECONDS="${AI_PROVIDER_CAPACITY_LEASE_SECONDS:-660}"
AI_PROVIDER_CAPACITY_WAIT_TIMEOUT_SECONDS="${AI_PROVIDER_CAPACITY_WAIT_TIMEOUT_SECONDS:-540.0}"
AI_PROVIDER_CAPACITY_POLL_SECONDS="${AI_PROVIDER_CAPACITY_POLL_SECONDS:-1.0}"
PUBSUB_PROJECT_ID="${PUBSUB_PROJECT_ID:-${PROJECT_ID}}"
STICKER_GENERATION_TOPIC="${STICKER_GENERATION_TOPIC:-sticker-generation-jobs}"
PUBSUB_PUBLISH_TIMEOUT_SECONDS="${PUBSUB_PUBLISH_TIMEOUT_SECONDS:-10}"
ENABLE_PUBSUB_WORKER_ENDPOINT="true"
WORKER_STALE_PROCESSING_SECONDS="${WORKER_STALE_PROCESSING_SECONDS:-660}"

LINE_CHANNEL_SECRET_NAME="${LINE_CHANNEL_SECRET_NAME:-line-channel-secret}"
GEMINI_API_KEY_SECRET_NAME="${GEMINI_API_KEY_SECRET_NAME:-gemini-api-key}"

missing_vars=()
for var_name in GCS_BUCKET_NAME LIFF_CHANNEL_ID; do
  if [[ -z "${!var_name:-}" ]]; then
    missing_vars+=("${var_name}")
  fi
done

if (( ${#missing_vars[@]} > 0 )); then
  echo "ERROR: Missing required environment variables: ${missing_vars[*]}" >&2
  exit 1
fi

TMP_ENV_VARS_FILE="$(mktemp)"
cleanup() {
  rm -f "${TMP_ENV_VARS_FILE}"
}
trap cleanup EXIT

for env_key in \
  PROJECT_ID \
  GCS_BUCKET_NAME \
  LIFF_CHANNEL_ID \
  BEAM_BASE_URL \
  PAYMENT_REDIRECT_URL \
  PAYMENT_WEBHOOK_PUBLIC_URL \
  PAYMENT_LINK_EXPIRY_MINUTES \
  PAYMENT_CURRENCY \
  BEAM_ENABLE_CARD \
  BEAM_ENABLE_CARD_INSTALLMENTS \
  BEAM_ENABLE_QR_PROMPTPAY \
  BEAM_ENABLE_EWALLETS \
  BEAM_ENABLE_MOBILE_BANKING \
  BEAM_ENABLE_BNPL \
  VERTEX_MODEL \
  VERTEX_LOCATION \
  GENAI_PROVIDER \
  GENAI_MODEL_ROUTING_ENABLED \
  PRIMARY_VERTEX_MODEL \
  FALLBACK_VERTEX_MODEL \
  GENAI_VERTEX_MODEL_ROUTE \
  GENAI_GEMINI_API_FALLBACK_MODEL \
  GENAI_PROMPT_PROFILE \
  GENAI_QUALITY_ATTEMPTS \
  GENAI_QUALITY_FALLBACK_ENABLED \
  GEMINI_API_BASE_URL \
  GEMINI_IMAGE_ASPECT_RATIO \
  GEMINI_IMAGE_SIZE \
  GENAI_FALLBACK_PROVIDER \
  GENAI_FALLBACK_MAX_RETRIES \
  LINE_PROFILE_CACHE_TTL_SECONDS \
  LINE_PROFILE_CACHE_GRACE_SECONDS \
  LINE_PROFILE_REQUEST_TIMEOUT \
  LINE_PROFILE_REQUEST_RETRIES \
  LINE_PROFILE_RETRY_DELAY \
  CORS_ALLOWED_ORIGINS \
  CORS_ALLOW_ORIGIN_REGEX \
  GENERATION_DISPATCH_MODE \
  GENERATION_CONCURRENCY \
  GENERATION_COOLDOWN_SECONDS \
  GENERATION_MAX_RETRIES \
  GENERATION_RETRY_BASE_DELAY \
  GENERATION_ATTEMPT_RESERVATION_RETRIES \
  GENERATION_ATTEMPT_RESERVATION_RETRY_BASE_DELAY \
  FIRESTORE_TRANSACTION_MAX_ATTEMPTS \
  AI_PROVIDER_MAX_CONCURRENT_CALLS \
  AI_PROVIDER_CAPACITY_LEASE_SECONDS \
  AI_PROVIDER_CAPACITY_WAIT_TIMEOUT_SECONDS \
  AI_PROVIDER_CAPACITY_POLL_SECONDS \
  PUBSUB_PROJECT_ID \
  STICKER_GENERATION_TOPIC \
  PUBSUB_PUBLISH_TIMEOUT_SECONDS \
  ENABLE_PUBSUB_WORKER_ENDPOINT \
  WORKER_STALE_PROCESSING_SECONDS; do
  append_env_var "${env_key}"
done

secret_mappings=(
  "LINE_CHANNEL_SECRET=${LINE_CHANNEL_SECRET_NAME}:latest"
  "GEMINI_API_KEY=${GEMINI_API_KEY_SECRET_NAME}:latest"
)
secret_mappings_csv="$(join_by_comma "${secret_mappings[@]}")"

missing_secrets=()
for secret_name in \
  "${LINE_CHANNEL_SECRET_NAME}" \
  "${GEMINI_API_KEY_SECRET_NAME}"; do
  if ! require_secret_with_enabled_version "${secret_name}" >/dev/null; then
    missing_secrets+=("${secret_name}")
  fi
done

if (( ${#missing_secrets[@]} > 0 )); then
  echo "ERROR: Missing Secret Manager secrets or enabled versions: ${missing_secrets[*]}" >&2
  echo "Create them before deploy. Example:" >&2
  echo "  printf '%s' \"\$GEMINI_API_KEY\" | gcloud secrets versions add ${GEMINI_API_KEY_SECRET_NAME} --project ${PROJECT_ID} --data-file=-" >&2
  exit 1
fi

echo "==> Configure Docker for Artifact Registry"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
ensure_artifact_repo

if [[ "${BUILD_IMAGE}" == "1" ]]; then
  build_flags=()
  if [[ "${NO_CACHE}" == "1" ]]; then
    build_flags+=(--no-cache)
  fi

  echo "==> Build & push worker image: ${IMAGE}"
  docker buildx build \
    --platform linux/amd64 \
    -t "${IMAGE}" \
    "${build_flags[@]}" \
    --push \
    "${SCRIPT_DIR}/backend"
else
  echo "==> Skip image build. Using IMAGE=${IMAGE}"
fi

deploy_args=(
  --project "${PROJECT_ID}"
  --region "${REGION}"
  --image "${IMAGE}"
  --service-account "${RUNTIME_SA}"
  --no-allow-unauthenticated
  --ingress "${INGRESS}"
  --memory "${MEMORY}"
  --cpu "${CPU}"
  --concurrency "${CONCURRENCY}"
  --min-instances "${MIN_INSTANCES}"
  --max-instances "${MAX_INSTANCES}"
  --timeout "${TIMEOUT}"
  --execution-environment gen2
  --env-vars-file "${TMP_ENV_VARS_FILE}"
  --set-secrets "${secret_mappings_csv}"
  --labels "app=stickerline,component=worker"
)

echo "==> Deploy Cloud Run worker service: ${SERVICE_NAME}"
gcloud run deploy "${SERVICE_NAME}" "${deploy_args[@]}"

echo "==> Worker URL:"
gcloud run services describe "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format "value(status.url)"
