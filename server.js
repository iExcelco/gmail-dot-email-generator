import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SheetService, generateLeadId } from './lib/sheetService.js';
import { sendResultsEmail } from './email-service.js';
import { handleLog, handleSendResults } from './lib/core.js';

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
    if (!process.env[m[1]]) process.env[m[1]] = value;
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
const BASE_PATH = PRIMARY_BASE_PATH; // kept for existing log/output references
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

// Thin Express adapter over the runtime-agnostic core (lib/core.js). All the
// validation / record-building / persistence logic lives in core so the
// Cloudflare Workers entrypoint (worker/index.js) runs byte-identical logic.
async function logRoute(req, res) {
  const { status, body } = await handleLog(
    {
      body: req.body,
      userAgent: req.headers['user-agent'] || '',
      ip: (req.headers['x-forwarded-for']?.toString().split(',')[0].trim()) || req.ip || ''
    },
    {
      generateLeadId,
      appendRow: sheetService ? (record) => sheetService.appendRow(record) : null,
      // Visibility: when sheets isn't configured we still log what WOULD have
      // been written. Helps GDV-005 root-cause diagnosis without a redeploy.
      onDisabled: (record) => console.log('[sheets:disabled] would-log lead:', JSON.stringify(record))
    }
  );
  res.status(status).json(body);
}

for (const bp of BASE_PATHS) {
  const route = bp === '/' ? '/api/log' : `${bp.replace(/\/$/, '')}/api/log`;
  app.post(route, logRoute);
}
if (!BASE_PATHS.includes('/')) {
  app.post('/api/log', logRoute);
}

async function sendResultsRoute(req, res) {
  const { status, body } = await handleSendResults(
    { body: req.body },
    { sendEmail: (args) => sendResultsEmail(args) }
  );
  res.status(status).json(body);
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
});
