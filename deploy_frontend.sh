#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-skitkerline}"
REGION="${REGION:-asia-southeast1}"
REPO="${REPO:-asia-southeast1-docker.pkg.dev/${PROJECT_ID}/stickerline}"

FE_SERVICE="${FE_SERVICE:-stickerline-fe}"

VITE_API_BASE_URL="${VITE_API_BASE_URL:-}"
VITE_LIFF_ID="${VITE_LIFF_ID:-}"

if [[ -z "${VITE_API_BASE_URL}" || -z "${VITE_LIFF_ID}" ]]; then
  echo "ERROR: VITE_API_BASE_URL and VITE_LIFF_ID are required."
  exit 1
fi

GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
FE_IMAGE="${REPO}/${FE_SERVICE}:${GIT_SHA}"

echo "==> Configure Docker for Artifact Registry"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

echo "==> Build Frontend image"
docker build \
  -t "${FE_IMAGE}" \
  --build-arg VITE_API_BASE_URL="${VITE_API_BASE_URL}" \
  --build-arg VITE_LIFF_ID="${VITE_LIFF_ID}" \
  Frontend

echo "==> Push Frontend image"
docker push "${FE_IMAGE}"

echo "==> Deploy Frontend (public)"
gcloud run deploy "${FE_SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${FE_IMAGE}" \
  --allow-unauthenticated

echo "==> Frontend URL:"
gcloud run services describe "${FE_SERVICE}" --project "${PROJECT_ID}" --region "${REGION}" --format 'value(status.url)'
