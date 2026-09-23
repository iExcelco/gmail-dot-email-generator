import test from 'node:test';
import assert from 'node:assert/strict';

import { captureLeadAndRun, recordResultsEmail } from '../lib/lead-capture-service.js';
import { setPoolForTests } from '../lib/db.js';

const record = (overrides = {}) => ({
  timestamp: '2026-09-11T00:00:00.000Z',
  leadId: 'IXL-GDG-20260911-000000-abc123',
  inputEmail: 'JohnSmith@gmail.com',
  baseLocal: 'johnsmith',
  domain: 'gmail.com',
  plusTag: '',
  mode: 'all',
  variantCount: 0,
  firstVariant: 'john.smith@gmail.com',
  userAgent: 'test',
  ip: '1.2.3.4',
  isWorkspace: 'no',
  workspaceDomain: '',
  plusTagsUsed: 'signup,promo',
  plusVariantCount: 4,
  consent: 'yes',
  ...overrides
});

// Records every call, in order, across the fake DB and the fake sheet.
function harness({ leadRow = null, appendRow = async () => 47 } = {}) {
  const calls = [];
  const client = {
    query: async (text, params) => {
      const t = text.replace(/\s+/g, ' ').trim();
      calls.push({ at: 'db', text: t, params });
      if (t.startsWith('insert into public.leads')) return { rows: [{ id: 'uuid-1' }] };
      if (t.startsWith('select * from gdg.leads')) return { rows: leadRow ? [leadRow] : [] };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  process.env.DATABASE_URL = 'postgresql://fake';
  setPoolForTests({ query: client.query, connect: async () => client });
  const sheetService = {
    appendRow: async (rec) => { calls.push({ at: 'sheet.append', rec }); return appendRow(rec); },
    updateFields: async (row, fields) => { calls.push({ at: 'sheet.update', row, fields }); return true; },
    appendAllLeadsRow: async (rec) => { calls.push({ at: 'sheet.allLeads', rec }); return true; }
  };
  const done = () => { delete process.env.DATABASE_URL; setPoolForTests(null); };
  return { calls, sheetService, done };
}

const firstIndex = (calls, pred) => calls.findIndex(pred);

test('captureLeadAndRun: lead -> DB -> sheet -> run -> finalize, in that order', async () => {
  const { calls, sheetService, done } = harness();
  const result = await captureLeadAndRun(record(), { sheetService, site: 'gmaildottrick.co' });

  assert.equal(result.leadId, 'IXL-GDG-20260911-000000-abc123');
  assert.match(result.runId, /^[0-9a-f]{16}$/);
  assert.equal(result.logged, true);

  const publicLead = firstIndex(calls, (c) => c.text?.startsWith('insert into public.leads'));
  const gdgLead = firstIndex(calls, (c) => c.text?.startsWith('insert into gdg.leads'));
  const append = firstIndex(calls, (c) => c.at === 'sheet.append');
  const rowNumber = firstIndex(calls, (c) => c.text?.startsWith('update gdg.leads set sheet_row_number'));
  const runInsert = firstIndex(calls, (c) => c.text?.startsWith('insert into gdg.runs'));
  const finalize = firstIndex(calls, (c) => c.text?.startsWith('update gdg.leads set lead_status'));
  const sheetUpdate = firstIndex(calls, (c) => c.at === 'sheet.update');
  assert.ok(publicLead >= 0 && publicLead < gdgLead, 'public.leads first');
  assert.ok(gdgLead < append, 'DB before sheet');
  assert.ok(append < rowNumber, 'sheet row number stored in the DB');
  assert.equal(calls[rowNumber].params[0], 47);
  assert.ok(rowNumber < runInsert, 'run saved after capture');
  assert.ok(runInsert < finalize && finalize < sheetUpdate, 'finalize DB then sheet');

  const appended = calls[append].rec;
  assert.equal(appended.leadStatus, 'started');
  assert.equal(appended.runId, result.runId);
  assert.equal(appended.inputEmail, 'JohnSmith@gmail.com', 'existing sheet columns unchanged');

  const run = calls[runInsert];
  assert.equal(run.params[0], result.runId);
  assert.equal(run.params[1], 'IXL-GDG-20260911-000000-abc123', 'run linked to lead');
  const saved = JSON.parse(run.params[17]);
  assert.equal(saved.headline.primary, 'john.smith@gmail.com');
  assert.equal(saved.variants.length, saved.headline.variantCount);

  assert.deepEqual(calls[sheetUpdate], {
    at: 'sheet.update', row: 47,
    fields: { leadStatus: 'completed', runId: result.runId, dotVariantCount: saved.headline.dotVariantCount }
  });
  const f = calls[finalize];
  assert.ok(f.params.includes('completed') && f.params.includes(result.runId));

  const stages = calls.filter((c) => c.text?.startsWith('insert into gdg.events')).map((c) => c.params[1]);
  assert.deepEqual(stages, ['capture', 'sheet_append', 'all_leads_append', 'generate', 'saved', 'sheet_update', 'done']);
  const allLeads = calls.find((c) => c.at === 'sheet.allLeads');
  assert.equal(allLeads.rec.leadId, 'IXL-GDG-20260911-000000-abc123', 'lead synced to [data] all-leads');
  const gdgLeadParams = calls[gdgLead].params;
  assert.equal(gdgLeadParams[6], 'gmaildottrick.co', 'site recorded');
  done();
});

test('captureLeadAndRun: a sheet failure is logged, the lead and run still land in the DB', async () => {
  const { calls, sheetService, done } = harness({ appendRow: async () => { throw new Error('quota'); } });
  const result = await captureLeadAndRun(record(), { sheetService });
  assert.equal(result.logged, false);
  assert.ok(result.runId);
  assert.ok(calls.some((c) => c.text?.startsWith('insert into gdg.runs')));
  assert.ok(!calls.some((c) => c.at === 'sheet.update'), 'no row to update');
  const err = calls.find((c) => c.text?.startsWith('insert into gdg.events') && c.params[1] === 'error');
  assert.equal(JSON.parse(err.params[2]).stage, 'sheet_append');
  done();
});

test('captureLeadAndRun: an address that cannot be rebuilt marks the lead failed, never throws', async () => {
  const { calls, sheetService, done } = harness();
  const result = await captureLeadAndRun(record({ inputEmail: 'not-an-email' }), { sheetService });
  assert.equal(result.runId, null);
  assert.ok(!calls.some((c) => c.text?.startsWith('insert into gdg.runs')));
  const upd = calls.find((c) => c.at === 'sheet.update');
  assert.equal(upd.fields.leadStatus, 'failed');
  done();
});

test('captureLeadAndRun works with no database and no sheet', async () => {
  delete process.env.DATABASE_URL;
  setPoolForTests(null);
  const result = await captureLeadAndRun(record(), { sheetService: null });
  assert.equal(result.logged, false);
  assert.match(result.runId, /^[0-9a-f]{16}$/);
});

test('recordResultsEmail: owned lead -> exports row, emailed in DB + public.leads + sheet', async () => {
  const leadRow = { lead_id: 'IXL-GDG-1', run_id: 'run1', sheet_row_number: 47 };
  const { calls, sheetService, done } = harness({ leadRow });
  await recordResultsEmail({ leadId: 'IXL-GDG-1', email: 'JohnSmith@gmail.com', ok: true }, { sheetService });
  const exp = calls.find((c) => c.text?.startsWith('insert into gdg.exports'));
  assert.deepEqual(exp.params, ['run1', 'IXL-GDG-1', 'auto_email', 'JohnSmith@gmail.com', true, null]);
  assert.ok(calls.some((c) => c.text?.startsWith('update public.leads set report_email_sent_at')));
  assert.deepEqual(calls.find((c) => c.at === 'sheet.update'), { at: 'sheet.update', row: 47, fields: { resultsEmailed: 'yes' } });
  done();
});

test('recordResultsEmail: a failed send is recorded; a lead id that is not the recipient\'s is ignored', async () => {
  const { calls, sheetService, done } = harness({ leadRow: null });
  await recordResultsEmail({ leadId: 'IXL-GDG-someone-else', email: 'a@gmail.com', ok: false, error: 'AGENTMAIL_API_KEY is not configured' }, { sheetService });
  const exp = calls.find((c) => c.text?.startsWith('insert into gdg.exports'));
  assert.deepEqual(exp.params, [null, null, 'auto_email', 'a@gmail.com', false, 'AGENTMAIL_API_KEY is not configured']);
  assert.ok(!calls.some((c) => c.text?.startsWith('update public.leads')));
  assert.ok(!calls.some((c) => c.at === 'sheet.update'));
  done();
});

test('recordResultsEmail: "Email me the list" grants consent on the lead, public.leads and the sheet', async () => {
  const leadRow = { lead_id: 'IXL-GDG-1', run_id: 'run1', sheet_row_number: 47 };
  const { calls, sheetService, done } = harness({ leadRow });
  await recordResultsEmail({ leadId: 'IXL-GDG-1', email: 'JohnSmith@gmail.com', ok: false, error: 'boom', consent: true }, { sheetService });
  const upd = calls.find((c) => c.text?.startsWith('update gdg.leads set consent = true'));
  assert.ok(upd, 'gdg.leads consent set');
  assert.equal(upd.params[0], 'IXL-GDG-1');
  assert.ok(calls.some((c) => c.text?.startsWith('update public.leads set consent_granted_at')));
  assert.ok(!calls.some((c) => c.text?.startsWith('update public.leads set report_email_sent_at')), 'send failed: not marked emailed');
  assert.deepEqual(calls.find((c) => c.at === 'sheet.update').fields, { resultsEmailed: 'failed', consent: 'yes' });
  done();
});
