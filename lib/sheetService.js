import { google } from 'googleapis';
import {
  HEADERS,
  LAST_COLUMN_LETTER,
  COLUMN_RANGE,
  generateLeadId,
  recordToRow
} from './sheetSchema.js';

// Re-export so existing importers (server.js) keep resolving generateLeadId
// from this module unchanged.
export { generateLeadId };

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

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
          // header row in place so new columns (Is Workspace, Workspace
          // Domain, Plus Tags Used, Plus Variant Count, Consent) are
          // labeled. We don't truncate or rewrite existing data.
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

  async appendRow(record) {
    await this.ensureInitialized();

    const row = recordToRow(record);

    const response = await this.sheetsClient.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tabName}!${COLUMN_RANGE}`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    });

    return response.data;
  }
}
