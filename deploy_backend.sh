#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/backend/.env}"

if [[ -f "${ENV_FILE}" ]]; then
  # Load defaults from backend/.env without clobbering explicitly provided env vars.
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -z "${line//[[:space:]]/}" ]] && continue
    [[ "${line}" =~ ^[[:space:]]*# ]] && continue

    if [[ "${line}" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[2]}"
      raw_value="${BASH_REMATCH[3]}"

      if [[ -z "${!key+x}" ]]; then
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
  done < "${ENV_FILE}"
fi

PROJECT_ID="${PROJECT_ID:-skitkerline}"
REGION="${REGION:-asia-southeast1}"
REPO="${REPO:-asia-southeast1-docker.pkg.dev/${PROJECT_ID}/stickerline}"

BE_SERVICE="${BE_SERVICE:-stickerline-be}"
RUN_SERVICE_ACCOUNT="${RUN_SERVICE_ACCOUNT:-superadmin@${PROJECT_ID}.iam.gserviceaccount.com}"
NO_CACHE="${NO_CACHE:-0}"
MEMORY="${MEMORY:-1Gi}"
ALLOW_UNAUTH="${ALLOW_UNAUTH:-1}"
MIN_INSTANCES="${MIN_INSTANCES:-1}"

GCS_BUCKET_NAME="${GCS_BUCKET_NAME:-}"
LIFF_CHANNEL_ID="${LIFF_CHANNEL_ID:-}"
LINE_CHANNEL_SECRET="${LINE_CHANNEL_SECRET:-}"
BEAM_BASE_URL="${BEAM_BASE_URL:-https://playground.api.beamcheckout.com}"
BEAM_MERCHANT_ID="${BEAM_MERCHANT_ID:-}"
BEAM_API_KEY="${BEAM_API_KEY:-}"
BEAM_WEBHOOK_HMAC_KEY="${BEAM_WEBHOOK_HMAC_KEY:-}"
PAYMENT_REDIRECT_URL="${PAYMENT_REDIRECT_URL:-}"
PAYMENT_WEBHOOK_PUBLIC_URL="${PAYMENT_WEBHOOK_PUBLIC_URL:-}"
PAYMENT_LINK_EXPIRY_MINUTES="${PAYMENT_LINK_EXPIRY_MINUTES:-30}"
PAYMENT_CURRENCY="${PAYMENT_CURRENCY:-THB}"
BEAM_ENABLE_CARD="${BEAM_ENABLE_CARD:-true}"
BEAM_ENABLE_CARD_INSTALLMENTS="${BEAM_ENABLE_CARD_INSTALLMENTS:-false}"
BEAM_ENABLE_QR_PROMPTPAY="${BEAM_ENABLE_QR_PROMPTPAY:-true}"
BEAM_ENABLE_EWALLETS="${BEAM_ENABLE_EWALLETS:-false}"
BEAM_ENABLE_MOBILE_BANKING="${BEAM_ENABLE_MOBILE_BANKING:-true}"
BEAM_ENABLE_BNPL="${BEAM_ENABLE_BNPL:-false}"
VERTEX_MODEL="${VERTEX_MODEL:-gemini-3-pro-image-preview}"
VERTEX_LOCATION="${VERTEX_LOCATION:-global}"
GENAI_PROVIDER="${GENAI_PROVIDER:-vertex}"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"
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
GENERATION_MAX_RETRIES="${GENERATION_MAX_RETRIES:-3}"
GENERATION_RETRY_BASE_DELAY="${GENERATION_RETRY_BASE_DELAY:-2}"
GENERATION_CONCURRENCY="${GENERATION_CONCURRENCY:-1}"
GENERATION_COOLDOWN_SECONDS="${GENERATION_COOLDOWN_SECONDS:-30}"

required_vars=(
  GCS_BUCKET_NAME
  LIFF_CHANNEL_ID
  LINE_CHANNEL_SECRET
  GEMINI_API_KEY
  BEAM_MERCHANT_ID
  BEAM_API_KEY
  BEAM_WEBHOOK_HMAC_KEY
  PAYMENT_REDIRECT_URL
  PAYMENT_WEBHOOK_PUBLIC_URL
)

missing_vars=()
for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    missing_vars+=("${var_name}")
  fi
done

if (( ${#missing_vars[@]} > 0 )); then
  echo "ERROR: Missing required environment variables: ${missing_vars[*]}"
  exit 1
fi

if [[ "${PAYMENT_REDIRECT_URL}" != */payment* ]]; then
  echo "WARNING: PAYMENT_REDIRECT_URL should usually point to the frontend /payment route."
  echo "Current value: ${PAYMENT_REDIRECT_URL}"
fi

GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
BE_IMAGE="${REPO}/${BE_SERVICE}:${GIT_SHA}"

TMP_ENV_VARS_FILE="$(mktemp)"
cleanup() {
  rm -f "${TMP_ENV_VARS_FILE}"
}
trap cleanup EXIT

append_env_var() {
  local key="$1"
  local value="${!key:-}"
  local escaped="${value//\'/\'\'}"
  printf "%s: '%s'\n" "${key}" "${escaped}" >> "${TMP_ENV_VARS_FILE}"
}

for env_key in \
  PROJECT_ID \
  GCS_BUCKET_NAME \
  LIFF_CHANNEL_ID \
  LINE_CHANNEL_SECRET \
  BEAM_BASE_URL \
  BEAM_MERCHANT_ID \
  BEAM_API_KEY \
  BEAM_WEBHOOK_HMAC_KEY \
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
  GEMINI_API_KEY \
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
  GENERATION_MAX_RETRIES \
  GENERATION_RETRY_BASE_DELAY \
  GENERATION_CONCURRENCY \
  GENERATION_COOLDOWN_SECONDS; do
  append_env_var "${env_key}"
done

echo "==> Configure Docker for Artifact Registry"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

BUILD_FLAGS=()
if [[ "${NO_CACHE}" == "1" ]]; then
  BUILD_FLAGS+=(--no-cache)
fi

echo "==> Build & Push Backend image (linux/amd64)"
docker buildx build \
  --platform linux/amd64 \
  -t "${BE_IMAGE}" \
  "${BUILD_FLAGS[@]}" \
  --push \
  backend

ALLOW_FLAG="--no-allow-unauthenticated"
if [[ "${ALLOW_UNAUTH}" == "1" ]]; then
  ALLOW_FLAG="--allow-unauthenticated"
fi

echo "==> Deploy Backend"
gcloud run deploy "${BE_SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${BE_IMAGE}" \
  --service-account "${RUN_SERVICE_ACCOUNT}" \
  "${ALLOW_FLAG}" \
  --memory "${MEMORY}" \
  --min-instances "${MIN_INSTANCES}" \
  --clear-secrets \
  --env-vars-file "${TMP_ENV_VARS_FILE}"

echo "==> Backend URL:"
gcloud run services describe "${BE_SERVICE}" --project "${PROJECT_ID}" --region "${REGION}" --format 'value(status.url)'
