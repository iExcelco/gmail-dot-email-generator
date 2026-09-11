#!/bin/bash
# Deployment script for Gmail Dot Variations Generator.
# Full runbook: ./DEPLOY.md
#
# ---- TWO-DEPLOYMENT MODEL (read this before shipping) -----------------------
# This app is deployed TWICE from the SAME container image:
#
#   1. PREFIXED  service `ixl-gmail-dot-generator`
#      APP_BASE_PATH=/gmail-dot-trick  (+ legacy /gmail-dot-variations-generator)
#      Serves https://agents.iexcel.co/gmail-dot-trick via the load balancer.
#
#   2. VANITY    service `ixl-gmail-dot-generator-vanity`
#      APP_BASE_PATH=/
#      Serves https://gmaildottrick.co/ directly at the root of the domain.
#
# server.js reads APP_BASE_PATH at RUNTIME (`process.env.APP_BASE_PATH || '/'`).
# Nothing is baked in at build time, so the vanity service reuses the exact
# image built by `production` — it only differs by env vars. That makes the
# vanity deploy cheap: no rebuild, just a `gcloud run deploy --image ...`.
#
# ==> A RELEASE IS NOT COMPLETE UNTIL BOTH SERVICES ARE UPDATED. <==
# Use `./deploy.sh all` to do both in the correct order (production, then
# vanity). Running only `production` leaves gmaildottrick.co on the OLD image.

set -euo pipefail

# ---- Pinned configuration (do not edit casually) ----------------------------
PROJECT_ID="iexcel-agents"
REGION="us-central1"
SERVICE_NAME="ixl-gmail-dot-generator"
VANITY_SERVICE_NAME="ixl-gmail-dot-generator-vanity"
GCLOUD_ACCOUNT="${GCLOUD_ACCOUNT:-ads-automation@iexcel-agents.iam.gserviceaccount.com}"
RUNTIME_SA="gmail-dot-gen-sheets@iexcel-agents.iam.gserviceaccount.com"
IMAGE_URI="gcr.io/${PROJECT_ID}/${SERVICE_NAME}:latest"

CANONICAL_PATH="/gmail-dot-trick"
LEGACY_PATH="/gmail-dot-variations-generator"
VANITY_PATH="/"
PUBLIC_HOST="https://agents.iexcel.co"
VANITY_HOST="https://gmaildottrick.co"
CLOUD_RUN_URL="https://ixl-gmail-dot-generator-454575866716.us-central1.run.app"

SHEETS_SPREADSHEET_ID="12y0qOlzsx5U8sV5jV7sgJW88BOQli9ENC6w1nLiTKLA"
SHEETS_TAB="gmail-email-generator"

# Secret Manager (project iexcel-agents). RUNTIME_SA needs
# roles/secretmanager.secretAccessor on each of these.
DATABASE_SECRET_NAME="DATABASE_URL"         # shared Neon Postgres; this app owns schema `gdg`
AGENTMAIL_SECRET_NAME="AGENTMAIL_API_KEY"   # results email
SECRETS="DATABASE_URL=${DATABASE_SECRET_NAME}:latest,AGENTMAIL_API_KEY=${AGENTMAIL_SECRET_NAME}:latest"

# ---- Commands ---------------------------------------------------------------

show_help() {
    cat <<EOF

Usage: ./deploy.sh <command>

This app runs as TWO Cloud Run services off ONE image:
  prefixed -> ${SERVICE_NAME}         APP_BASE_PATH=${CANONICAL_PATH}
              serves ${PUBLIC_HOST}${CANONICAL_PATH}
  vanity   -> ${VANITY_SERVICE_NAME}  APP_BASE_PATH=${VANITY_PATH}
              serves ${VANITY_HOST}/

APP_BASE_PATH is read at RUNTIME by server.js — nothing is baked in at build
time — so the vanity service reuses the image built by 'production' and only
overrides env vars. A release is NOT done until BOTH are deployed: use 'all'.

Commands:
  local       Run dev server at http://localhost:8080 (no DB, no email)
              For production secrets + DB: ./scripts/dev-with-secrets.sh
  production  Build image and deploy the PREFIXED service
              (canonical: ${PUBLIC_HOST}${CANONICAL_PATH})
  vanity      Deploy the already-built image to the VANITY service
              (${VANITY_HOST}/). No rebuild — run 'production' first.
  all         Full release: 'production' then 'vanity' (use this by default)
  validate    Curl all live URLs and assert HTTP 200, and assert that
              ${VANITY_HOST}/ serves 200 directly (NOT a redirect)
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

    echo "==> [1/5] npm ci"
    npm ci

    echo "==> [2/5] npm test"
    npm test

    echo "==> [3/5] Cloud Build (image: ${IMAGE_URI})"
    gcloud builds submit \
        --tag "${IMAGE_URI}" \
        --project "${PROJECT_ID}" \
        --account "${GCLOUD_ACCOUNT}"

    echo "==> [4/5] Database migrations (idempotent; Neon Postgres via Secret Manager)"
    DATABASE_URL="$(gcloud secrets versions access latest --secret "${DATABASE_SECRET_NAME}" --project "${PROJECT_ID}" --account "${GCLOUD_ACCOUNT}")" \
        node scripts/db-migrate.js

    echo "==> [5/5] Cloud Run deploy"
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
        --set-env-vars "APP_BASE_PATH=${CANONICAL_PATH},APP_LEGACY_BASE_PATHS=${LEGACY_PATH},NODE_ENV=production,GOOGLE_SHEETS_SPREADSHEET_ID=${SHEETS_SPREADSHEET_ID},GOOGLE_SHEETS_TAB=${SHEETS_TAB}" \
        --set-secrets "${SECRETS}"

    echo
    echo "==> Prefixed service deployed."
    echo "    NOT DONE YET: ${VANITY_HOST}/ still runs the OLD revision."
    echo "    Run './deploy.sh vanity' (or use './deploy.sh all') to finish."
}

deploy_vanity() {
    echo "==> Deploying to ${VANITY_HOST}/"
    echo "    project=${PROJECT_ID}  service=${VANITY_SERVICE_NAME}  account=${GCLOUD_ACCOUNT}"
    echo "    Reusing image built by 'production': ${IMAGE_URI}"
    echo "    (APP_BASE_PATH is runtime-only, so no rebuild is needed; migrations ran in 'production'.)"

    echo "==> [1/1] Cloud Run deploy"
    gcloud run deploy "${VANITY_SERVICE_NAME}" \
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
        --set-env-vars "APP_BASE_PATH=${VANITY_PATH},NODE_ENV=production,GOOGLE_SHEETS_SPREADSHEET_ID=${SHEETS_SPREADSHEET_ID},GOOGLE_SHEETS_TAB=${SHEETS_TAB}" \
        --set-secrets "${SECRETS}"

    echo
    echo "==> Vanity deploy complete. Run './deploy.sh validate' to verify."
}

deploy_all() {
    echo "==> FULL RELEASE: prefixed + vanity"
    deploy_production
    echo
    deploy_vanity
    echo
    echo "==> Both services deployed. Run './deploy.sh validate' to verify."
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

    # Vanity domain must serve the app itself at the root — a 200 with NO
    # redirect. A 30x here means gmaildottrick.co is bouncing to agents.iexcel.co
    # instead of being served by ${VANITY_SERVICE_NAME}.
    echo "==> Validating vanity domain (must be 200, must NOT redirect)"
    local vanity_code
    vanity_code=$(curl -sS -o /dev/null -w "%{http_code}" "${VANITY_HOST}/" || echo "000")
    if [ "${vanity_code}" = "200" ]; then
        printf "    [ OK ] %s  -> %s/ (direct, no redirect)\n" "${vanity_code}" "${VANITY_HOST}"
    elif [ "${vanity_code}" -ge 300 ] 2>/dev/null && [ "${vanity_code}" -lt 400 ] 2>/dev/null; then
        local location
        location=$(curl -sS -o /dev/null -w "%{redirect_url}" "${VANITY_HOST}/" || echo "?")
        printf "    [FAIL] %s  -> %s/ REDIRECTS to %s (expected a direct 200)\n" \
            "${vanity_code}" "${VANITY_HOST}" "${location}"
        fail=1
    else
        printf "    [FAIL] %s  -> %s/\n" "${vanity_code}" "${VANITY_HOST}"
        fail=1
    fi

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
    vanity)      deploy_vanity ;;
    all)         deploy_all ;;
    validate)    validate_live ;;
    help|--help|-h) show_help ;;
    *)
        echo "Unknown command: ${1}"
        show_help
        exit 1
        ;;
esac
