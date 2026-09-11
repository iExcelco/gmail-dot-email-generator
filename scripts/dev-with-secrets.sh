#!/usr/bin/env bash
# Local dev server with the SAME secrets production uses, pulled from Secret Manager
# into the process environment only. Nothing is written to disk.
#
# Writes to the REAL Neon database and the REAL leads sheet tab, and (with consent
# checked) sends a REAL results email. Pre-set a variable to override it, e.g.
#   AGENTMAIL_API_KEY= ./scripts/dev-with-secrets.sh        # no emails go out
#   GOOGLE_SHEETS_TAB=scratch ./scripts/dev-with-secrets.sh
set -euo pipefail
cd "$(dirname "$0")/.."
SA="${GCLOUD_ACCOUNT:-ads-automation@iexcel-agents.iam.gserviceaccount.com}"
PROJECT=iexcel-agents
get() { gcloud secrets versions access latest --secret "$1" --project "$PROJECT" --account "$SA"; }
export DATABASE_URL="${DATABASE_URL-$(get DATABASE_URL)}"
export AGENTMAIL_API_KEY="${AGENTMAIL_API_KEY-$(get AGENTMAIL_API_KEY)}"
# Google Sheets as the owner service account (the leads sheet is shared with it as editor).
export GOOGLE_APPLICATION_CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS:-$HOME/.config/gcloud/ads-automation-key.json}"
export GOOGLE_SHEETS_SPREADSHEET_ID="${GOOGLE_SHEETS_SPREADSHEET_ID:-12y0qOlzsx5U8sV5jV7sgJW88BOQli9ENC6w1nLiTKLA}"
export GOOGLE_SHEETS_TAB="${GOOGLE_SHEETS_TAB:-gmail-email-generator}"
export APP_BASE_PATH="${APP_BASE_PATH:-/}"
export PORT="${PORT:-8080}"
export NODE_ENV=development
echo "[dev] secrets loaded from Secret Manager"
node scripts/db-migrate.js
echo "[dev] starting server on :$PORT"
exec node server.js
