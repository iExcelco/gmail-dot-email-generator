// Shared, runtime-agnostic Google Sheets schema for the Gmail Dot Generator.
//
// This module is DEPENDENCY-FREE (no googleapis, no Node built-ins) so it can
// be imported by both runtimes:
//   - lib/sheetService.js   (Cloud Run — googleapis + ADC)
//   - lib/sheetsRest.js     (Cloudflare Workers — WebCrypto JWT + REST fetch)
// Keeping the column list, A1 range math, lead-id format, and record→row
// mapping in one place means the two runtimes can never drift on the 16-column
// layout (they already diverged once when columns were added).

export const HEADERS = [
  'Timestamp',
  'Lead ID',
  'Input Email',
  'Base Local',
  'Domain',
  'Plus Tag',
  'Mode',
  'Variant Count',
  'First Variant',
  'User Agent',
  'IP',
  'Is Workspace',
  'Workspace Domain',
  'Plus Tags Used',
  'Plus Variant Count',
  'Consent'
];

// Translate column count -> A1-style range. Beyond Z we need two letters
// (e.g. AA) so we compute it generically rather than assuming <= 26 columns.
export function columnLetter(index) {
  // index is 1-based.
  let n = index;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export const LAST_COLUMN_LETTER = columnLetter(HEADERS.length);
export const COLUMN_RANGE = `A:${LAST_COLUMN_LETTER}`;

function pad(n) {
  return n.toString().padStart(2, '0');
}

export function generateLeadId(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  const rand = Math.random().toString(36).slice(2, 8);
  return `IXL-GDG-${y}${m}${d}-${hh}${mm}${ss}-${rand}`;
}

// Map a log record to a sheet row in HEADERS order. Shared so both the
// googleapis and REST append paths write identical columns.
export function recordToRow(record) {
  return [
    record.timestamp || new Date().toISOString(),
    record.leadId || '',
    record.inputEmail || '',
    record.baseLocal || '',
    record.domain || '',
    record.plusTag || '',
    record.mode || '',
    record.variantCount ?? '',
    record.firstVariant || '',
    record.userAgent || '',
    record.ip || '',
    record.isWorkspace || '',
    record.workspaceDomain || '',
    record.plusTagsUsed || '',
    record.plusVariantCount ?? '',
    record.consent || ''
  ];
}
