import test from 'node:test';
import assert from 'node:assert/strict';

import { SheetService, buildSheetRow, buildAllLeadsRow, parseUpdatedRangeRowNumber } from '../lib/sheetService.js';

const ORIGINAL_16 = [
  'Timestamp', 'Lead ID', 'Input Email', 'Base Local', 'Domain', 'Plus Tag', 'Mode', 'Variant Count', 'First Variant',
  'User Agent', 'IP', 'Is Workspace', 'Workspace Domain', 'Plus Tags Used', 'Plus Variant Count', 'Consent'
];

function fakeSheets(existingHeader) {
  const calls = [];
  const values = {
    get: async (req) => { calls.push({ op: 'get', req }); return { data: { values: [existingHeader] } }; },
    update: async (req) => { calls.push({ op: 'update', req }); return { data: {} }; },
    append: async (req) => { calls.push({ op: 'append', req }); return { data: { updates: { updatedRange: 'gmail-email-generator!A47:T47' } } }; },
    batchUpdate: async (req) => { calls.push({ op: 'batchUpdate', req }); return { data: {} }; }
  };
  return { calls, client: { spreadsheets: { values } } };
}

function service(existingHeader) {
  const { calls, client } = fakeSheets(existingHeader);
  const s = new SheetService({ spreadsheetId: 'sheet1', tabName: 'gmail-email-generator' });
  s.sheetsClient = client;
  return { s, calls };
}

test('parseUpdatedRangeRowNumber', () => {
  assert.equal(parseUpdatedRangeRowNumber('gmail-email-generator!A47:T47'), 47);
  assert.equal(parseUpdatedRangeRowNumber("'AI Search Grader Leads'!A3:P3"), 3);
  assert.equal(parseUpdatedRangeRowNumber(''), null);
});

test('buildSheetRow keeps the original 16 columns in place and adds 4 at the end', () => {
  const row = buildSheetRow({
    timestamp: 't', leadId: 'L', inputEmail: 'e', mode: 'all', variantCount: 0, consent: 'yes',
    leadStatus: 'started', runId: 'r1', dotVariantCount: 9, resultsEmailed: 'yes'
  });
  assert.equal(row.length, 20);
  assert.deepEqual([row[0], row[1], row[2], row[6], row[7], row[15]], ['t', 'L', 'e', 'all', 0, 'yes']);
  assert.deepEqual(row.slice(16), ['started', 'r1', 9, 'yes']);
});

test('an old 16-column header row is extended in place; append returns the row number', async () => {
  const { s, calls } = service(ORIGINAL_16);
  const rowNumber = await s.appendRow({ leadId: 'L' });
  assert.equal(rowNumber, 47);
  const header = calls.find((c) => c.op === 'update');
  assert.deepEqual(header.req.requestBody.values[0].slice(0, 16), ORIGINAL_16);
  assert.deepEqual(header.req.requestBody.values[0].slice(16), ['Lead Status', 'Run ID', 'Dot Variant Count', 'Results Emailed']);
  const append = calls.find((c) => c.op === 'append');
  assert.equal(append.req.range, 'gmail-email-generator!A:T');
});

test('updateFields writes only the named cells of the same row', async () => {
  const { s, calls } = service([...ORIGINAL_16, 'Lead Status', 'Run ID', 'Dot Variant Count', 'Results Emailed']);
  await s.updateFields(47, { leadStatus: 'completed', runId: 'r1', dotVariantCount: 9 });
  await s.updateFields(47, { resultsEmailed: 'failed' });
  const [first, second] = calls.filter((c) => c.op === 'batchUpdate');
  assert.deepEqual(first.req.requestBody.data, [
    { range: 'gmail-email-generator!Q47', values: [['completed']] },
    { range: 'gmail-email-generator!R47', values: [['r1']] },
    { range: 'gmail-email-generator!S47', values: [[9]] }
  ]);
  assert.deepEqual(second.req.requestBody.data, [{ range: 'gmail-email-generator!T47', values: [['failed']] }]);
  assert.ok(!calls.some((c) => c.op === 'update'), 'header already current: not rewritten');
  assert.equal(await s.updateFields(null, { leadStatus: 'x' }), false);
});

test('all-leads sync: row matches the shared tab columns and appends to [data] all-leads', async () => {
  const row = buildAllLeadsRow({ timestamp: 't', leadId: 'IXL-GDG-1', inputEmail: 'a@gmail.com', domain: 'gmail.com' });
  assert.equal(row.length, 18, 'Tool..PDL Enriched');
  assert.deepEqual(row.slice(0, 5), ['IXL-GDG', 't', 'IXL-GDG-1', 'a@gmail.com', 'gmail.com']);
  assert.equal(row[17], 'No');
  assert.ok(row.slice(5, 17).every((v) => v === ''));

  const { s, calls } = service([...ORIGINAL_16, 'Lead Status', 'Run ID', 'Dot Variant Count', 'Results Emailed']);
  await s.appendAllLeadsRow({ leadId: 'IXL-GDG-1' });
  const append = calls.find((c) => c.op === 'append');
  assert.equal(append.req.range, "'[data] all-leads'!A:R");
  assert.equal(append.req.insertDataOption, 'INSERT_ROWS');
});

test('updateFields can flip the existing Consent column (P) without touching the rest', async () => {
  const { s, calls } = service([...ORIGINAL_16, 'Lead Status', 'Run ID', 'Dot Variant Count', 'Results Emailed']);
  await s.updateFields(47, { consent: 'yes' });
  assert.deepEqual(calls.find((c) => c.op === 'batchUpdate').req.requestBody.data, [{ range: 'gmail-email-generator!P47', values: [['yes']] }]);
});
