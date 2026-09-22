import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file'
];

const HEADERS = [
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
  'Consent',
  // Added with the Postgres lead DB. Always append new columns at the END so
  // the team's existing columns keep their positions.
  'Lead Status',
  'Run ID',
  'Dot Variant Count',
  'Results Emailed'
];

// Record field -> header, for the columns that change after the row is appended.
const UPDATABLE_FIELDS = {
  leadStatus: 'Lead Status',
  runId: 'Run ID',
  dotVariantCount: 'Dot Variant Count',
  resultsEmailed: 'Results Emailed'
};

// Translate column count -> A1-style range. Beyond Z we need two letters
// (e.g. AA) so we compute it generically rather than assuming <= 26 columns.
function columnLetter(index) {
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

const LAST_COLUMN_LETTER = columnLetter(HEADERS.length);
const COLUMN_RANGE = `A:${LAST_COLUMN_LETTER}`;

// Cross-tool lead sync: every tool's leads in one tab of the same spreadsheet
// (feeds "[pivot] all-leads"). Its columns are shared with the other tools, so
// this tool fills what it has and leaves the rest blank.
export const ALL_LEADS_TAB = '[data] all-leads';
export const ALL_LEADS_TOOL = 'IXL-GDG';
const ALL_LEADS_HEADERS = [
  'Tool', 'Timestamp', 'Lead ID', 'Email', 'Domain', 'Full Name', 'Job Title', 'Company', 'Location',
  'Industry', 'LinkedIn', 'Seniority', 'Company Size', 'Critical Issues', 'Ad Partners', 'Tech Stack Items',
  'Report URL', 'PDL Enriched'
];
const ALL_LEADS_RANGE = `'${ALL_LEADS_TAB}'!A:${columnLetter(ALL_LEADS_HEADERS.length)}`;

export function buildAllLeadsRow(record) {
  const row = new Array(ALL_LEADS_HEADERS.length).fill('');
  row[0] = ALL_LEADS_TOOL;
  row[1] = record.timestamp || '';
  row[2] = record.leadId || '';
  row[3] = record.inputEmail || '';
  row[4] = record.domain || '';
  row[17] = 'No';
  return row;
}

// "gmail-email-generator!A47:T47" -> 47
export function parseUpdatedRangeRowNumber(updatedRange = '') {
  const match = updatedRange.match(/![A-Z]+(\d+):[A-Z]+(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function buildSheetRow(record) {
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
    record.consent || '',
    record.leadStatus || '',
    record.runId || '',
    record.dotVariantCount ?? '',
    record.resultsEmailed || ''
  ];
}

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

export class SheetService {
  constructor({ spreadsheetId, tabName }) {
    this.spreadsheetId = spreadsheetId;
    this.tabName = tabName;
    this.sheetsClient = null;
    this.headersEnsured = false;
    this.initPromise = null;
  }

  async ensureInitialized() {
    if (this.sheetsClient && this.headersEnsured) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      if (!this.spreadsheetId || !this.tabName) {
        throw new Error('SheetService missing spreadsheetId or tabName');
      }

      if (!this.sheetsClient) {
        const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
        const client = await auth.getClient();
        this.sheetsClient = google.sheets({ version: 'v4', auth: client });
      }

      if (!this.headersEnsured) {
        const existing = await this.sheetsClient.spreadsheets.values.get({
          spreadsheetId: this.spreadsheetId,
          range: `${this.tabName}!A1:${LAST_COLUMN_LETTER}1`
        });

        const existingRow = (existing.data.values && existing.data.values[0]) || [];
        const hasHeaders = existingRow.length > 0;

        if (!hasHeaders) {
          await this.sheetsClient.spreadsheets.values.update({
            spreadsheetId: this.spreadsheetId,
            range: `${this.tabName}!A1`,
            valueInputOption: 'RAW',
            requestBody: { values: [HEADERS] }
          });
        } else if (existingRow.length < HEADERS.length) {
          // Sheet exists from a prior version with fewer columns. Extend the
          // header row in place so newly added columns (always appended at
          // the end) are labeled. We don't truncate or rewrite existing data.
          await this.sheetsClient.spreadsheets.values.update({
            spreadsheetId: this.spreadsheetId,
            range: `${this.tabName}!A1`,
            valueInputOption: 'RAW',
            requestBody: { values: [HEADERS] }
          });
        }

        this.headersEnsured = true;
      }

      return true;
    })().catch((error) => {
      this.initPromise = null;
      throw error;
    });

    return this.initPromise;
  }

  // Returns the sheet row number the record landed on (null if unknown).
  async appendRow(record) {
    await this.ensureInitialized();

    const response = await this.sheetsClient.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tabName}!${COLUMN_RANGE}`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [buildSheetRow(record)] }
    });

    return parseUpdatedRangeRowNumber(response.data.updates?.updatedRange || '');
  }

  // Overwrite only the given fields (keys of UPDATABLE_FIELDS) on an existing row.
  async updateFields(rowNumber, fields) {
    if (!rowNumber) return false;
    const data = [];
    for (const [key, header] of Object.entries(UPDATABLE_FIELDS)) {
      if (fields[key] === undefined) continue;
      const column = columnLetter(HEADERS.indexOf(header) + 1);
      data.push({ range: `${this.tabName}!${column}${rowNumber}`, values: [[fields[key] ?? '']] });
    }
    if (!data.length) return false;

    await this.ensureInitialized();
    await this.sheetsClient.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    });
    return true;
  }

  // Cross-tool lead sync: one row per lead in ALL_LEADS_TAB.
  async appendAllLeadsRow(record) {
    await this.ensureInitialized();
    await this.sheetsClient.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: ALL_LEADS_RANGE,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [buildAllLeadsRow(record)] }
    });
    return true;
  }
}
