#!/bin/bash
# Deployment script for Gmail Dot Variations Generator.
# Full runbook: ./DEPLOY.md

set -euo pipefail

# ---- Pinned configuration (do not edit casually) ----------------------------
PROJECT_ID="iexcel-agents"
REGION="us-central1"
SERVICE_NAME="ixl-gmail-dot-generator"
GCLOUD_ACCOUNT="${GCLOUD_ACCOUNT:-ads-automation@iexcel-agents.iam.gserviceaccount.com}"
RUNTIME_SA="gmail-dot-gen-sheets@iexcel-agents.iam.gserviceaccount.com"
IMAGE_URI="gcr.io/${PROJECT_ID}/${SERVICE_NAME}:latest"

CANONICAL_PATH="/gmail-dot-trick"
LEGACY_PATH="/gmail-dot-variations-generator"
PUBLIC_HOST="https://agents.iexcel.co"
CLOUD_RUN_URL="https://ixl-gmail-dot-generator-454575866716.us-central1.run.app"

SHEETS_SPREADSHEET_ID="12y0qOlzsx5U8sV5jV7sgJW88BOQli9ENC6w1nLiTKLA"
SHEETS_TAB="gmail-email-generator"

# ---- Commands ---------------------------------------------------------------

show_help() {
    cat <<EOF

Usage: ./deploy.sh <command>

Commands:
  local       Run dev server at http://localhost:8080
  production  Build and deploy to Cloud Run (canonical: ${PUBLIC_HOST}${CANONICAL_PATH})
  validate    Curl all live URLs and assert HTTP 200
  help        Show this message

Full runbook: ./DEPLOY.md
EOF
}

run_local() {
    pkill -f "node server.js" 2>/dev/null || true
    APP_BASE_PATH="/" node server.js
}

deploy_production() {
    echo "==> Deploying to ${PUBLIC_HOST}${CANONICAL_PATH}"
    echo "    project=${PROJECT_ID}  service=${SERVICE_NAME}  account=${GCLOUD_ACCOUNT}"

    echo "==> [1/4] npm ci"
    npm ci

    echo "==> [2/4] npm test"
    npm test

    echo "==> [3/4] Cloud Build (image: ${IMAGE_URI})"
    gcloud builds submit \
        --tag "${IMAGE_URI}" \
        --project "${PROJECT_ID}" \
        --account "${GCLOUD_ACCOUNT}"

    echo "==> [4/4] Cloud Run deploy"
    gcloud run deploy "${SERVICE_NAME}" \
        --image "${IMAGE_URI}" \
        --platform managed \
        --region "${REGION}" \
        --allow-unauthenticated \
        --project "${PROJECT_ID}" \
        --account "${GCLOUD_ACCOUNT}" \
        --service-account "${RUNTIME_SA}" \
        --port 8080 \
        --memory 256Mi \
        --cpu 1 \
        --concurrency 80 \
        --timeout 60 \
        --max-instances 10 \
        --set-env-vars "APP_BASE_PATH=${CANONICAL_PATH},APP_LEGACY_BASE_PATHS=${LEGACY_PATH},NODE_ENV=production,GOOGLE_SHEETS_SPREADSHEET_ID=${SHEETS_SPREADSHEET_ID},GOOGLE_SHEETS_TAB=${SHEETS_TAB}"

    echo
    echo "==> Deploy complete. Run './deploy.sh validate' to verify."
}

validate_live() {
    local fail=0
    local urls=(
        "${PUBLIC_HOST}${CANONICAL_PATH}"
        "${PUBLIC_HOST}${LEGACY_PATH}"
        "${CLOUD_RUN_URL}${CANONICAL_PATH}"
    )

    echo "==> Validating live URLs"
    for url in "${urls[@]}"; do
        local code
        code=$(curl -sS -L -o /dev/null -w "%{http_code}" "${url}" || echo "000")
        if [ "${code}" = "200" ]; then
            printf "    [ OK ] %s  -> %s\n" "${code}" "${url}"
        else
            printf "    [FAIL] %s  -> %s\n" "${code}" "${url}"
            fail=1
        fi
    done

    if [ "${fail}" -ne 0 ]; then
        echo "==> Validation FAILED. See ./DEPLOY.md troubleshooting."
        exit 1
    fi
    echo "==> All URLs healthy."
}

# ---- Entrypoint -------------------------------------------------------------

if [ ! -f "package.json" ]; then
    echo "ERROR: run this script from the project root (no package.json here)."
    exit 1
fi

case "${1:-help}" in
    local)       run_local ;;
    production)  deploy_production ;;
    validate)    validate_live ;;
    help|--help|-h) show_help ;;
    *)
        echo "Unknown command: ${1}"
        show_help
        exit 1
        ;;
esac
