#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/Frontend/.env}"

if [[ -f "${ENV_FILE}" ]]; then
  # Load defaults from Frontend/.env without clobbering explicitly provided env vars.
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

FE_SERVICE="${FE_SERVICE:-stickerline-fe}"
NO_CACHE="${NO_CACHE:-0}"

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

BUILD_FLAGS=()
if [[ "${NO_CACHE}" == "1" ]]; then
  BUILD_FLAGS+=(--no-cache)
fi

echo "==> Build & Push Frontend image (linux/amd64)"
docker buildx build \
  --platform linux/amd64 \
  -t "${FE_IMAGE}" \
  "${BUILD_FLAGS[@]}" \
  --build-arg VITE_API_BASE_URL="${VITE_API_BASE_URL}" \
  --build-arg VITE_LIFF_ID="${VITE_LIFF_ID}" \
  --push \
  Frontend

echo "==> Deploy Frontend (public)"
gcloud run deploy "${FE_SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${FE_IMAGE}" \
  --allow-unauthenticated

echo "==> Frontend URL:"
gcloud run services describe "${FE_SERVICE}" --project "${PROJECT_ID}" --region "${REGION}" --format 'value(status.url)'
