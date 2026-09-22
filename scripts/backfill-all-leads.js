#!/usr/bin/env node
// One-time (safe to re-run): copy this tool's leads from its own tab into the
// cross-tool "[data] all-leads" tab, skipping Lead IDs already there, and make the
// "[pivot] all-leads" source open-ended so appended rows are counted.
// Usage: GOOGLE_APPLICATION_CREDENTIALS=... GOOGLE_SHEETS_SPREADSHEET_ID=... node scripts/backfill-all-leads.js
import { google } from 'googleapis';
import { ALL_LEADS_TAB, buildAllLeadsRow } from '../lib/sheetService.js';

const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '12y0qOlzsx5U8sV5jV7sgJW88BOQli9ENC6w1nLiTKLA';
const toolTab = process.env.GOOGLE_SHEETS_TAB || 'gmail-email-generator';
const PIVOT_TAB = '[pivot] all-leads';

const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

// 1. Backfill.
const toolRows = (await sheets.spreadsheets.values.get({ spreadsheetId, range: `${toolTab}!A2:E` })).data.values || [];
const existing = new Set(((await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${ALL_LEADS_TAB}'!C2:C` })).data.values || []).map((r) => r[0]));
const missing = toolRows
  .filter(([, leadId]) => leadId && !existing.has(leadId))
  .map(([timestamp, leadId, inputEmail, , domain]) => buildAllLeadsRow({ timestamp, leadId, inputEmail, domain }));
if (missing.length) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${ALL_LEADS_TAB}'!A:R`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: missing }
  });
}
console.log(`${toolTab}: ${toolRows.length} leads, ${missing.length} added to ${ALL_LEADS_TAB}, ${toolRows.length - missing.length} already there`);

// 2. Pivot source: drop the fixed end row so it covers every row of the data tab.
const meta = await sheets.spreadsheets.get({ spreadsheetId, ranges: [`'${PIVOT_TAB}'!A1`], includeGridData: true });
const pivotSheet = meta.data.sheets[0];
const pivot = pivotSheet.data?.[0]?.rowData?.[0]?.values?.[0]?.pivotTable;
if (!pivot) {
  console.log(`${PIVOT_TAB}: no pivot table at A1; left unchanged`);
} else if (pivot.source.endRowIndex === undefined) {
  console.log(`${PIVOT_TAB}: source already open-ended`);
} else {
  const before = pivot.source.endRowIndex;
  delete pivot.source.endRowIndex;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateCells: {
          start: { sheetId: pivotSheet.properties.sheetId, rowIndex: 0, columnIndex: 0 },
          rows: [{ values: [{ pivotTable: pivot }] }],
          fields: 'pivotTable'
        }
      }]
    }
  });
  console.log(`${PIVOT_TAB}: source was rows 1-${before}, now open-ended`);
}
