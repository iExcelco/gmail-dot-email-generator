# Changelog

All notable changes to this project will be documented in this file.

## [1.4.0] - Unreleased
### Added
- **Lead database.** Every lead and every run is saved to the shared Neon Postgres in this app's own schema `gdg` (`leads`, `runs`, `variants`, `exports`, `events`), plus one row per lead in the shared `public.leads`. The database is the source of truth; the sheet keeps working as before.
- `buildVariantSet()` in `gmailDots.js`: one function for what a run generates, used by both the page and the server.
- Sheet tab gets 4 columns at the end: `Lead Status`, `Run ID`, `Dot Variant Count`, `Results Emailed`. The row is appended at capture and updated in place when the run finishes and when the results email goes out.
- `scripts/db-migrate.js` (`npm run db:migrate`), `scripts/dev-with-secrets.sh`, ESLint (`npm run lint`).

### Fixed
- **Results email never sent in production**: neither Cloud Run service had `AGENTMAIL_API_KEY`. `deploy.sh` now mounts it from Secret Manager on both services.
- **Results email silently dropped for large all-mode runs**: the page sent the full variant list with `keepalive`, and browsers refuse keepalive bodies over 64 KB (~2,000+ variants). The server now rebuilds the variants itself, which also stops `/api/send-results` from emailing caller-supplied text.
- `.env.local` no longer overrides a variable that is explicitly set to empty.

## [1.3.0] - 2026-05-03
### Changed
- Renamed canonical public path from `/gmail-dot-email-generator` to `/gmail-dot-variations-generator`. Legacy path still serves via `APP_LEGACY_BASE_PATHS`.
- `deploy.sh` rewritten for clarity; added `./deploy.sh validate` subcommand.
- Added `DEPLOY.md` as the single deployment runbook.

### Deployed
- Cloud Run revision `ixl-gmail-dot-generator-00008-74t` (100% traffic) on 2026-05-03. See `DEPLOY.md` for accounts, URLs, and validation.

## [1.2.0] - 2026-05-03
### Added
- **Plus-tag (`+alias`) variations** alongside dot variations.
  - `DEFAULT_PLUS_TAGS`: `signup`, `newsletter`, `promo`, `social`, `shop`.
  - `normalizePlusTags()` and `generatePlusTagVariants()` in `gmailDots.js`.
  - "Plus tags (optional)" input on the service page.
- **Google Workspace custom-domain support.**
  - `parseGmailAddress` accepts `options.workspaceDomain`.
  - "Using Google Workspace?" checkbox + custom-domain input.
  - Verified: `mycorp.com` produces 51 dot variants on `@mycorp.com`.
- **GTM IDs** wired through the service page.
- New test suite `test-variations.js` (13 tests) covering dot, plus-tag, and Workspace variants. Total: 26/26 passing (up from 13).
- Sheet schema extended with 5 columns: `Is Workspace`, `Workspace Domain`, `Plus Tags Used`, `Plus Variant Count`, `Consent`. Existing sheets auto-extend headers on first write.
- Console logging breadcrumb when Sheets logging is disabled.

### Fixed
- **GDV-003**: Footer "Contact" link now points to `https://iexcel.co/#contact-us` (was a broken `/contact` 404).
- **GDV-004**: Removed personal `tel:` link; replaced with the iExcel homepage contact anchor.
- **GDV-005**: `server.js` no longer 400s Workspace submissions before they reach the sheet.

## [1.1.0] - 2026-03-30T12:45:00-05:00
### Added
- New integration test suite in `tests/integration.test.js` to verify permutation counts and filtering.
- "Copy All (All Pages)" button to capture every generated Gmail variation in one click.

### Changed
- Increased maximum visible variations on screen from 10 to 51.
- Updated "Copy Page" button logic and messaging for better clarity.
- Refined status bar feedback to show accurate generation and visibility counts.
- Adjusted UI font weights for improved readability.
