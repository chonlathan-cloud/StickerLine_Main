#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-skitkerline}"
REGION="${REGION:-asia-southeast1}"
REPO="${REPO:-asia-southeast1-docker.pkg.dev/${PROJECT_ID}/stickerline}"

BE_SERVICE="${BE_SERVICE:-stickerline-be}"
RUN_SERVICE_ACCOUNT="${RUN_SERVICE_ACCOUNT:-superadmin@${PROJECT_ID}.iam.gserviceaccount.com}"

GCS_BUCKET_NAME="${GCS_BUCKET_NAME:-}"
LIFF_CHANNEL_ID="${LIFF_CHANNEL_ID:-}"
VERTEX_MODEL="${VERTEX_MODEL:-gemini-3-pro-image-preview}"
VERTEX_LOCATION="${VERTEX_LOCATION:-global}"
GENAI_PROVIDER="${GENAI_PROVIDER:-vertex}"
GENAI_FALLBACK_PROVIDER="${GENAI_FALLBACK_PROVIDER:-gemini_api}"
GENAI_FALLBACK_MAX_RETRIES="${GENAI_FALLBACK_MAX_RETRIES:-2}"
GENERATION_MAX_RETRIES="${GENERATION_MAX_RETRIES:-3}"
GENERATION_RETRY_BASE_DELAY="${GENERATION_RETRY_BASE_DELAY:-2}"
GENERATION_CONCURRENCY="${GENERATION_CONCURRENCY:-1}"
GENERATION_COOLDOWN_SECONDS="${GENERATION_COOLDOWN_SECONDS:-30}"

if [[ -z "${GCS_BUCKET_NAME}" || -z "${LIFF_CHANNEL_ID}" ]]; then
  echo "ERROR: GCS_BUCKET_NAME and LIFF_CHANNEL_ID are required."
  exit 1
fi

GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
BE_IMAGE="${REPO}/${BE_SERVICE}:${GIT_SHA}"

echo "==> Configure Docker for Artifact Registry"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

echo "==> Build Backend image"
docker build -t "${BE_IMAGE}" backend

echo "==> Push Backend image"
docker push "${BE_IMAGE}"

echo "==> Deploy Backend (private)"
gcloud run deploy "${BE_SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${BE_IMAGE}" \
  --service-account "${RUN_SERVICE_ACCOUNT}" \
  --no-allow-unauthenticated \
  --set-env-vars "PROJECT_ID=${PROJECT_ID},GCS_BUCKET_NAME=${GCS_BUCKET_NAME},LIFF_CHANNEL_ID=${LIFF_CHANNEL_ID},VERTEX_MODEL=${VERTEX_MODEL},VERTEX_LOCATION=${VERTEX_LOCATION},GENAI_PROVIDER=${GENAI_PROVIDER},GENAI_FALLBACK_PROVIDER=${GENAI_FALLBACK_PROVIDER},GENAI_FALLBACK_MAX_RETRIES=${GENAI_FALLBACK_MAX_RETRIES},GENERATION_MAX_RETRIES=${GENERATION_MAX_RETRIES},GENERATION_RETRY_BASE_DELAY=${GENERATION_RETRY_BASE_DELAY},GENERATION_CONCURRENCY=${GENERATION_CONCURRENCY},GENERATION_COOLDOWN_SECONDS=${GENERATION_COOLDOWN_SECONDS}" \
  --set-secrets "GEMINI_API_KEY=gemini_api_key:latest,LINE_CHANNEL_SECRET=line_channel_secret:latest,OMISE_SECRET_KEY=omise_secret_key:latest,OMISE_PUBLIC_KEY=omise_public_key:latest"

echo "==> Backend URL:"
gcloud run services describe "${BE_SERVICE}" --project "${PROJECT_ID}" --region "${REGION}" --format 'value(status.url)'
