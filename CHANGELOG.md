# Changelog

All notable changes to this project will be documented in this file.

## [1.7.0] - 2026-09-23
### Added
- **Intro above the tool**: H1 "Gmail Dot Trick Generator", a direct-answer lede with real examples, and quick facts.
- **SEO / AEO / GEO**: visible article below the tool with question-style H2s (what it is, how many variations with the 2^(n-1) formula and table, how to use it, dots vs. +tags table, use cases, FAQ) and an "Updated" date. One `@graph` JSON-LD block: Organization, WebSite, WebPage, WebApplication, HowTo, FAQPage. New title, description, robots meta, OG/Twitter tags, canonical `https://gmaildottrick.co/`. New `/robots.txt` (search and AI crawlers welcome, `/api/` blocked), `/sitemap.xml` and `/llms.txt`. The FAQ, its JSON-LD and llms.txt all come from `lib/seo.js`, so they can't drift apart.

### Fixed
- **Google Workspace addresses got wrong variations.** Google: "If you use Gmail through work, school, or other organization (like yourdomain.com or yourschool.edu), dots do change your address." (support.google.com/mail/answer/7436150). Workspace addresses now keep their dots exactly as typed and only get +tag versions (previously dot variants, and +tags built on the dot-stripped name, which reach a different mailbox). The page opens the +Tags tab for them and says why.

## [1.6.0] - 2026-09-23
### Changed
- **New page: Results Table.** One address field and a live table, with no Generate button, mode radios, or Workspace checkbox. Dots and +Tags tabs with counts; click any row to copy it; Copy all (one per line); Download CSV; the list scrolls through every variation (only the visible rows are in the DOM, so 65k rows stay smooth). Paste cleanup keeps just the address from input like "John <john@gmail.com>"; Enter copies the best pick. Why / How it works / FAQ are collapsed below the tool. The page went from 1,827 to 795 lines.
- **Workspace is detected from the domain.** `classifyAddress()` in gmailDots.js: Gmail typos (gmail.con) get a "Did you mean" fix, known non-Google inboxes (yahoo.com, outlook.com, ...) get a clear message, and any other valid domain is treated as Google Workspace. The server applies the same check.
- **Consent is the "Email me the list" button** (the checkbox is gone). The server records it on the lead (gdg.leads, public.leads, and the sheet's Consent column) and refuses `/api/send-results` when `consent` is false.
- A typed address is captured once the visitor pauses (1.5 s), pastes, or copies, and only once per address.

## [1.5.0] - 2026-09-22
### Added
- **Lead sync:** every lead is also appended to the cross-tool `[data] all-leads` tab of the IRP Lead Intelligence sheet (`Tool = IXL-GDG`), next to LeadGen, AI Search Grader and Landing Page Analyzer. `scripts/backfill-all-leads.js` backfilled the 49 existing leads (skips Lead IDs already there) and made the `[pivot] all-leads` source open-ended (it was fixed to rows 1-38).

## [1.4.0] - 2026-09-12
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
