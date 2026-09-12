# Deployment Runbook

This is the **only** document you need to deploy this project. If anything else in the repo contradicts it, this file wins.

---

## TL;DR

```bash
./deploy.sh production    # build, push, deploy
./deploy.sh validate      # curl all live URLs, assert HTTP 200
```

That's it. Read the rest of this file the first time, then forget it.

---

## What gets deployed where

| Thing | Value |
|---|---|
| **App** | Gmail Dot Variations Generator (Node 20 / Express) |
| **GitHub** | https://github.com/iExcel-Micah/gmail-dot-email-generator (branch `main`) |
| **Public URL (canonical)** | https://agents.iexcel.co/gmail-dot-variations-generator |
| **Public URL (legacy, kept alive)** | https://agents.iexcel.co/gmail-dot-email-generator |
| **Cloud Run direct URL** | https://ixl-gmail-dot-generator-454575866716.us-central1.run.app |
| **GCP project** | `iexcel-agents` |
| **Cloud Run service** | `ixl-gmail-dot-generator` |
| **Region** | `us-central1` |
| **Container registry** | `gcr.io/iexcel-agents/ixl-gmail-dot-generator:latest` |

---

## Identities (who runs what)

| Identity | Role | Used for |
|---|---|---|
| `ads@iexcel.co` | Human deployer (gcloud account) | Running `./deploy.sh production`. Must have Cloud Run Admin + Cloud Build Editor on `iexcel-agents`. |
| `gmail-dot-gen-sheets@iexcel-agents.iam.gserviceaccount.com` | Cloud Run runtime SA | Reads/writes the Google Sheet at runtime. Already attached to the service. |
| `iExcel-Micah` (GitHub) | Source of truth | Source code lives in `iExcel-Micah/gmail-dot-email-generator`. |

If `ads@iexcel.co` isn't the active gcloud account on your machine:

```bash
gcloud auth login ads@iexcel.co
gcloud config set project iexcel-agents
```

The deploy script passes `--account` and `--project` explicitly, so you don't have to keep them as defaults — but you do have to be **logged in** as `ads@iexcel.co`.

---

## Custom URL — how it actually routes

The `agents.iexcel.co/...` URL is **not** something `deploy.sh` controls. It's an external HTTPS load balancer (or domain mapping) that routes path prefixes to this Cloud Run service. The service then reads `APP_BASE_PATH` to know which prefix it's serving.

- Canonical prefix: `/gmail-dot-variations-generator` → `APP_BASE_PATH`
- Legacy prefix: `/gmail-dot-email-generator` → `APP_LEGACY_BASE_PATHS`

Both env vars are set by `deploy.sh` automatically. **If the canonical URL ever 404s after a deploy, the load balancer routing is the problem, not this app.** Verify with the Cloud Run direct URL first to isolate.

---

## Deploying

From the project root:

```bash
./deploy.sh production
```

What it does (in order):
1. `npm ci` — clean install
2. `npm test` — must pass; deploy aborts on failure
3. `gcloud builds submit` — builds Docker image via Cloud Build, pushes to GCR
4. `node scripts/db-migrate.js` — applies `db/migrations/*.sql` to Neon (idempotent)
5. `gcloud run deploy` — rolls out new revision at 100% traffic, with `DATABASE_URL` and `AGENTMAIL_API_KEY` from Secret Manager

Typical runtime: **3–5 min**.

---

## Lead database (Neon Postgres)

Every `/api/log` call is one lead + one run. Order: lead → `gdg.leads` + one row in the shared `public.leads` → sheet row appended (row number stored on the lead) → the run is rebuilt server-side with `buildVariantSet` (same function the page uses) and saved with every variant in one transaction → the lead and the same sheet row are finalized. Every results email (`/api/send-results`) writes a `gdg.exports` row, success or failure.

| Thing | Value |
|---|---|
| Connection string | Secret Manager `DATABASE_URL` (project `iexcel-agents`) |
| This app's schema | `gdg` — `leads`, `runs` (full output in `report jsonb`), `variants`, `exports`, `events`, `migrations` |
| Shared table | `public.leads` — INSERT one row per lead only; the rest of `public.*` is Drizzle-managed by the Free Digital Marketing Audit. Never alter it. `asg.*` belongs to the AI Search Grader. |
| Migrations | `npm run db:migrate` (needs `DATABASE_URL`); runs automatically in `./deploy.sh production` |

With `DATABASE_URL` unset (plain `./deploy.sh local`, tests), every DB call is a no-op.

**Runtime SA secret access.** `gmail-dot-gen-sheets@…` must hold `roles/secretmanager.secretAccessor` on both `DATABASE_URL` and `AGENTMAIL_API_KEY`, or the Cloud Run deploy fails:

```bash
for s in DATABASE_URL AGENTMAIL_API_KEY; do
  gcloud secrets add-iam-policy-binding "$s" --project iexcel-agents \
    --member serviceAccount:gmail-dot-gen-sheets@iexcel-agents.iam.gserviceaccount.com \
    --role roles/secretmanager.secretAccessor
done
```

---

## Validating after deploy

```bash
./deploy.sh validate
```

This curls the canonical URL, the legacy URL, and the Cloud Run direct URL, and exits non-zero if any returns non-200.

Manual spot-check:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://agents.iexcel.co/gmail-dot-variations-generator
```

Expected: `200`. Page title in the response body should be `Free Gmail Dot Variations Generator | iExcel`.

---

## Local development

```bash
./deploy.sh local
```

Serves at http://localhost:8080 with `APP_BASE_PATH=/`. No Cloud Run, no build, just `node server.js`. Reads `.env.local` for credentials.

With production secrets and the real database:

```bash
./scripts/dev-with-secrets.sh                        # real DB, real sheet tab, real emails
AGENTMAIL_API_KEY= ./scripts/dev-with-secrets.sh     # same, but no emails go out
```

Secrets are pulled from Secret Manager into the process env only; migrations run first.

---

## Troubleshooting

| Symptom | First thing to check |
|---|---|
| `gcloud builds submit` fails with permission error | You're not logged in as `ads@iexcel.co`. Run `gcloud auth login ads@iexcel.co`. |
| Canonical URL 404s, but Cloud Run direct URL works | Load balancer/domain-mapping problem. Not this app. |
| Cloud Run direct URL 5xx | Check Cloud Run logs: `gcloud run services logs read ixl-gmail-dot-generator --region us-central1 --project iexcel-agents`. |
| Sheet rows aren't appearing | Service account `gmail-dot-gen-sheets@…` lost editor access on spreadsheet `12y0qOlzsx5U8sV5jV7sgJW88BOQli9ENC6w1nLiTKLA`. |
| `npm test` fails | Fix the test before deploying. The script intentionally aborts. |

---

## What's intentionally NOT here

- No CI/CD pipeline. Deploys are manual via `./deploy.sh production`.
- No staging environment. Production is the only Cloud Run service.
- No secrets in this file. Production secrets live in Secret Manager (`DATABASE_URL`, `AGENTMAIL_API_KEY`); local ones in `.env.local` or `scripts/dev-with-secrets.sh`.
