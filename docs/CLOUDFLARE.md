# Deploying GDV to Cloudflare Workers

The Gmail Dot Variations Generator can run on **two** runtimes from the same repo:

| Runtime | Entry | Auth to Sheets | HTML | Status |
| --- | --- | --- | --- | --- |
| **Cloud Run** (existing, prod) | `server.js` (Express) | keyless ADC via attached service account + `googleapis` | `node:fs` read of `service-page.html` | unchanged — still builds from `main` |
| **Cloudflare Workers** (new) | `worker/index.js` (fetch handler) | service-account **private key** → WebCrypto RS256 JWT → OAuth token → Sheets REST | Workers Static Assets (`public/`) | this port |

Both call the same runtime-agnostic core (`lib/core.js`) and share the sheet
schema (`lib/sheetSchema.js`), so validation/logging behaviour is identical.

## Deploy account

Deploy to the **ads@iexcel.co** Cloudflare account. `wrangler.jsonc` deliberately
omits `account_id`, so wrangler uses whatever you're authenticated as. Authenticate
first:

```bash
npx wrangler login          # interactive, choose the ads@iexcel.co account
# or, non-interactive:
export CLOUDFLARE_API_TOKEN=...        # a token scoped to the ads@iexcel.co account
export CLOUDFLARE_ACCOUNT_ID=...       # the ads@iexcel.co account id
```

## Two deployments (same build, runtime-driven base path)

`APP_BASE_PATH` is read at **runtime** by `worker/index.js`, so one build serves both:

| Deployment | Worker name | `APP_BASE_PATH` | URL |
| --- | --- | --- | --- |
| Prefixed | `ixl-gmail-dot-generator` | `/gmail-dot-trick` | agents.iexcel.co/gmail-dot-trick |
| Vanity | `ixl-gmail-dot-generator-vanity` | `/` | gmaildottrick.co |

```bash
npm run cf:deploy                 # prefixed (top-level env)
npm run cf:deploy -- --env vanity # vanity
```

`cf:deploy` runs `cf:sync` first, which copies `service-page.html` → `public/`
(the ASSETS directory; `public/` is git-ignored and generated, never committed).

## Secrets (never in wrangler.jsonc or git)

```bash
# The FULL service-account JSON (Sheets private key), single line:
wrangler secret put GOOGLE_SA_KEY                 # + --env vanity for the vanity worker
wrangler secret put AGENTMAIL_API_KEY             # + --env vanity
```

Non-secret config (`APP_BASE_PATH`, `GOOGLE_SHEETS_SPREADSHEET_ID`,
`GOOGLE_SHEETS_TAB`) lives in `wrangler.jsonc`. For local dev, copy
`.dev.vars.example` → `.dev.vars` and fill in the secrets.

## Local development

```bash
npm install          # installs wrangler (devDependency)
npm run cf:dev       # cf:sync + wrangler dev  (Miniflare, no Cloudflare login needed)
```

Test both base paths locally by setting `APP_BASE_PATH` in `.dev.vars` (`/` vs
`/gmail-dot-trick`) or editing `wrangler.jsonc`.

## ⚠️ Security trade-off — READ THIS

This port **replaces keyless Application Default Credentials with a long-lived
service-account private key** stored as a Worker secret (`GOOGLE_SA_KEY`).

- **Cloud Run today:** no key on disk. The runtime service account
  (`gmail-dot-gen-sheets@iexcel-agents.iam.gserviceaccount.com`) is attached by
  the platform and tokens are fetched from the instance metadata server. Nothing
  to leak, nothing to rotate.
- **Workers:** there is no metadata server, so a private key must be supplied.
  A long-lived RSA private key now exists as a secret. If it leaks, an attacker
  can mint tokens for that service account until the key is revoked.

**This is a real security regression, not a detail.** Mitigations:

1. **Dedicated least-privilege service account.** Do not reuse a broadly-scoped
   SA. Create one whose ONLY grant is Editor on the single spreadsheet
   (`12y0qOlzsx5U8sV5jV7sgJW88BOQli9ENC6w1nLiTKLA`), share just that file with it,
   and grant no project-level IAM roles.
2. **Key rotation.** Rotate the key on a schedule; keep a documented one-command
   rotation (`gcloud iam service-accounts keys create` → `wrangler secret put`
   → delete the old key).
3. **Blast-radius limits.** The Sheets scope only touches shared spreadsheets, so
   a dedicated SA with no other access limits exposure to this one sheet.
4. **Consider a boundary service.** If the org later wants to avoid a standing key
   in Workers entirely, front the Sheets write with a tiny authenticated Cloud
   Run/Function endpoint (keeps ADC) and have the Worker call it. Not implemented
   here — noted as the keyless alternative.
