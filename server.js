import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SheetService, generateLeadId } from './lib/sheetService.js';
import { validateEmail } from './lib/emailValidator.js';
import { parseGmailAddress, buildVariantSet } from './gmailDots.js';
import { sendResultsEmail } from './email-service.js';
import { captureLeadAndRun, recordResultsEmail } from './lib/lead-capture-service.js';
import { isDbEnabled } from './lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Lightweight .env.local loader (no extra dep)
const envFile = path.join(__dirname, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Only fill vars that are truly unset: an explicitly empty var (e.g.
    // `AGENTMAIL_API_KEY= ./scripts/dev-with-secrets.sh`) must stay empty.
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const PORT = parseInt(process.env.PORT || '8080', 10);
const PRIMARY_BASE_PATH = process.env.APP_BASE_PATH || '/';
// Comma-separated legacy base paths we still serve for URL rename transition windows.
// Example: APP_LEGACY_BASE_PATHS=/gmail-dot-email-generator
// Note: /gmail-dot-variations-generator is handled separately via a 301 redirect
// to the new canonical /gmail-dot-trick (defined below); don't list it here.
const LEGACY_BASE_PATHS = (process.env.APP_LEGACY_BASE_PATHS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const BASE_PATHS = [...new Set([PRIMARY_BASE_PATH, ...LEGACY_BASE_PATHS])];
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const TAB_NAME = process.env.GOOGLE_SHEETS_TAB || 'gmail-email-generator';

const app = express();
app.use(express.json({ limit: '2mb' }));

// 301 redirect old canonical slug to new canonical slug. Defined BEFORE any
// static / route handlers so it always wins. This preserves SEO equity from
// /gmail-dot-variations-generator (prior canonical) to /gmail-dot-trick.
app.get(/^\/gmail-dot-variations-generator(\/.*)?$/, (req, res) => {
  res.redirect(301, req.url.replace('/gmail-dot-variations-generator', '/gmail-dot-trick'));
});

const staticDir = __dirname;
for (const bp of BASE_PATHS) {
  app.use(bp, express.static(staticDir, { index: false }));
}
if (!BASE_PATHS.includes('/')) {
  app.use('/', express.static(staticDir, { index: false }));
}

const sheetService = SPREADSHEET_ID
  ? new SheetService({ spreadsheetId: SPREADSHEET_ID, tabName: TAB_NAME })
  : null;

if (!sheetService) {
  console.warn('[sheets] GOOGLE_SHEETS_SPREADSHEET_ID not set — /api/log will accept but not persist.');
}

async function logRoute(req, res) {
  const {
    email,
    mode,
    variantCount,
    firstVariant,
    workspaceDomain,
    isWorkspace,
    plusTagsUsed,
    plusVariantCount,
    consent
  } = req.body || {};

  if (typeof email !== 'string' || !email) {
    return res.status(400).json({ ok: false, error: 'email required' });
  }

  // In Workspace mode we deliberately skip the Gmail-only validateEmail check
  // because the user is using a custom company domain. We still parse the
  // address to make sure it's structurally a valid email and that the local
  // part is gmail-rules-compatible (letters/numbers/dots only).
  const wsDomain = typeof workspaceDomain === 'string' ? workspaceDomain.trim().toLowerCase() : '';
  const useWorkspace = !!isWorkspace && !!wsDomain;

  if (!useWorkspace) {
    const validation = validateEmail(email);
    if (!validation.valid) {
      return res.status(400).json({ ok: false, error: validation.reason });
    }
  }

  const parsed = parseGmailAddress(email, useWorkspace ? { workspaceDomain: wsDomain } : undefined);
  if (!parsed) {
    return res.status(400).json({
      ok: false,
      error: useWorkspace ? 'invalid email for the supplied workspace domain' : 'invalid gmail address'
    });
  }

  const safePlusTags = Array.isArray(plusTagsUsed)
    ? plusTagsUsed.filter((t) => typeof t === 'string').slice(0, 50).join(',')
    : '';

  const record = {
    timestamp: new Date().toISOString(),
    leadId: generateLeadId(),
    inputEmail: email,
    baseLocal: parsed.baseLocal,
    domain: parsed.domain,
    plusTag: parsed.plusTag || '',
    mode: mode === 'all' ? 'all' : 'wordSplit',
    variantCount: Number.isFinite(variantCount) ? variantCount : '',
    firstVariant: typeof firstVariant === 'string' ? firstVariant : '',
    userAgent: (req.headers['user-agent'] || '').slice(0, 500),
    ip: (req.headers['x-forwarded-for']?.toString().split(',')[0].trim()) || req.ip || '',
    isWorkspace: useWorkspace ? 'yes' : 'no',
    workspaceDomain: useWorkspace ? wsDomain : '',
    plusTagsUsed: safePlusTags,
    plusVariantCount: Number.isFinite(plusVariantCount) ? plusVariantCount : '',
    consent: consent ? 'yes' : 'no'
  };

  // Lead -> DB + sheet, run -> DB, then finalize both. Never throws.
  const result = await captureLeadAndRun(record, { sheetService, site: req.get('host') || '' });
  res.json({ ok: true, leadId: result.leadId, runId: result.runId, logged: result.logged });
}

for (const bp of BASE_PATHS) {
  const route = bp === '/' ? '/api/log' : `${bp.replace(/\/$/, '')}/api/log`;
  app.post(route, logRoute);
}
if (!BASE_PATHS.includes('/')) {
  app.post('/api/log', logRoute);
}

async function sendResultsRoute(req, res) {
  const { email, baseEmail, mode, workspaceDomain, isWorkspace, plusTagsUsed, leadId } = req.body || {};

  if (typeof email !== 'string' || !email) {
    return res.status(400).json({ ok: false, error: 'email required' });
  }

  // Workspace-mode bypass — mirrors the pattern in /api/log so users on
  // custom Google Workspace domains (e.g. Micah@iexcel.co) can request
  // emailed results without tripping the Gmail-only validator.
  const wsDomain = typeof workspaceDomain === 'string' ? workspaceDomain.trim().toLowerCase() : '';
  const useWorkspace = !!isWorkspace && !!wsDomain;

  if (!useWorkspace) {
    const validation = validateEmail(email);
    if (!validation.valid) {
      return res.status(400).json({ ok: false, error: validation.reason });
    }
  } else {
    // Light structural sanity check for workspace-mode addresses since we
    // skipped the strict Gmail-only validator above.
    const parsed = parseGmailAddress(email, { workspaceDomain: wsDomain });
    if (!parsed) {
      return res.status(400).json({
        ok: false,
        error: 'invalid email for the supplied workspace domain'
      });
    }
  }

  // Rebuild the variations here (same function the page uses) instead of
  // trusting a client-sent list: a list of thousands blew past the browser's
  // 64 KB keepalive limit so the request never left the page, and it let any
  // caller put arbitrary text in an email sent from our inbox.
  const set = buildVariantSet(email, {
    mode,
    workspaceDomain: useWorkspace ? wsDomain : '',
    plusTags: Array.isArray(plusTagsUsed) ? plusTagsUsed.filter((t) => typeof t === 'string').slice(0, 50) : []
  });
  if (!set) {
    return res.status(400).json({ ok: false, error: 'invalid email' });
  }
  const variations = [set.primary, ...set.extras];

  // EMAIL-GDV-500: Do NOT block the response on email failures. If AgentMail
  // is misconfigured or the template throws, we still return 200 so the UI
  // doesn't show a generic 500 to the user — their variations already
  // rendered client-side. We log the failure for ops.
  let sendError = null;
  try {
    await sendResultsEmail({
      to: email,
      baseEmail: baseEmail || email,
      mode: set.mode,
      variations,
    });
  } catch (error) {
    sendError = error;
    console.error('[email] send failed:', {
      message: error && error.message,
      name: error && error.name,
      stack: error && error.stack,
      to: email,
      mode,
      variationCount: variations.length,
    });
  }

  // Every send is recorded (exports row, lead marked emailed in DB + sheet). Never throws.
  await recordResultsEmail({
    leadId: typeof leadId === 'string' ? leadId : '',
    email,
    ok: !sendError,
    error: sendError ? sendError.message || String(sendError) : null
  }, { sheetService });

  res.json({ ok: true, emailQueued: !sendError });
}

for (const bp of BASE_PATHS) {
  const route = bp === '/' ? '/api/send-results' : `${bp.replace(/\/$/, '')}/api/send-results`;
  app.post(route, sendResultsRoute);
}
if (!BASE_PATHS.includes('/')) {
  app.post('/api/send-results', sendResultsRoute);
}

for (const bp of BASE_PATHS) {
  app.get(bp, (_req, res) => {
    res.sendFile(path.join(staticDir, 'service-page.html'));
  });
  if (bp !== '/' && !bp.endsWith('/')) {
    app.get(bp + '/', (_req, res) => {
      res.sendFile(path.join(staticDir, 'service-page.html'));
    });
  }
}

app.listen(PORT, () => {
  console.log(`Gmail Dot Generator running on port ${PORT}`);
  console.log(`Base paths: ${BASE_PATHS.join(', ')}`);
  console.log(`Sheets logging: ${sheetService ? `enabled (tab="${TAB_NAME}")` : 'DISABLED'}`);
  console.log(`Database: ${isDbEnabled() ? 'enabled (schema gdg)' : 'DISABLED (DATABASE_URL not set)'}`);
});
