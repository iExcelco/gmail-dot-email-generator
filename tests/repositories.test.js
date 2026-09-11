import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVariantSet } from '../gmailDots.js';
import { buildRunReport } from '../lib/lead-capture-service.js';
import { runRowsFromReport, runsRepo, leadsRepo, exportsRepo, eventsRepo, CONSENT_TEXT, CONSENT_TEXT_VERSION } from '../lib/repositories.js';
import { setPoolForTests } from '../lib/db.js';

const report = (mode = 'all') => buildRunReport(
  buildVariantSet('JohnSmith@gmail.com', { mode, plusTags: 'signup, promo' }),
  { id: 'abc123abc123abc1', leadId: 'IXL-GDG-1', email: 'JohnSmith@gmail.com', createdAt: '2026-09-11T00:00:00.000Z', durationMs: 3 }
);

function fakePool(rowsFor = () => [{ id: 'uuid-1' }]) {
  const log = [];
  const client = {
    query: async (text, params) => {
      const t = text.replace(/\s+/g, ' ').trim();
      log.push({ text: t, params });
      return { rows: rowsFor(t), rowCount: 1 };
    },
    release() {}
  };
  return { log, query: client.query, connect: async () => client };
}

function withFakeDb(pool) {
  process.env.DATABASE_URL = 'postgresql://fake';
  setPoolForTests(pool);
  return () => {
    delete process.env.DATABASE_URL;
    setPoolForTests(null);
  };
}

test('runRowsFromReport explodes a run into the run row and one row per variant', () => {
  const r = report();
  const { run, variants } = runRowsFromReport(r, { leadId: 'IXL-GDG-1' });
  assert.equal(run.id, 'abc123abc123abc1');
  assert.equal(run.lead_id, 'IXL-GDG-1');
  assert.equal(run.domain, 'gmail.com');
  assert.equal(run.base_local, 'johnsmith');
  assert.equal(run.mode, 'all');
  assert.equal(run.primary_variant, 'john.smith@gmail.com');
  assert.deepEqual(run.plus_tags, ['signup', 'promo']);
  assert.equal(run.variant_count, variants.length);
  assert.equal(run.plus_variant_count, 4, '2 tags x (base + word-split) locals');
  assert.equal(run.dot_variant_count + run.plus_variant_count, run.variant_count);
  assert.equal(variants[0].kind, 'primary');
  assert.equal(variants[0].position, 0);
  assert.ok(variants.some((v) => v.kind === 'dot'));
  assert.ok(variants.some((v) => v.address === 'john.smith+signup@gmail.com' && v.kind === 'plus'));
});

test('runsRepo.saveReport writes the run and every variant in one transaction', async () => {
  const pool = fakePool();
  const done = withFakeDb(pool);
  const r = report();
  const id = await runsRepo.saveReport(r, { leadId: 'IXL-GDG-1' });
  assert.equal(id, 'abc123abc123abc1');
  const texts = pool.log.map((l) => l.text);
  assert.equal(texts[0], 'BEGIN');
  assert.equal(texts[texts.length - 1], 'COMMIT');
  const runInsert = pool.log.find((l) => l.text.startsWith('insert into gdg.runs'));
  assert.equal(runInsert.params[1], 'IXL-GDG-1');
  assert.equal(JSON.parse(runInsert.params[17]).id, 'abc123abc123abc1', 'full report stored as jsonb');
  assert.ok(texts.includes('delete from gdg.variants where run_id = $1'));
  const variantInserts = pool.log.filter((l) => l.text.startsWith('insert into gdg.variants'));
  assert.equal(variantInserts.length, 1, 'all variants in a single statement');
  const [, positions, addresses, kinds] = variantInserts[0].params;
  assert.equal(addresses.length, r.variants.length);
  assert.deepEqual(positions, r.variants.map((_, i) => i));
  assert.equal(kinds[0], 'primary');
  done();
});

test('leadsRepo.create writes the shared public.leads row, then the gdg.leads row with its uuid', async () => {
  const pool = fakePool();
  const done = withFakeDb(pool);
  const rec = await leadsRepo.create({
    leadId: 'IXL-GDG-1', email: 'a@gmail.com', domain: 'gmail.com', consent: true, createdAt: '2026-09-11T00:00:00.000Z'
  });
  assert.equal(rec.publicLeadId, 'uuid-1');
  assert.ok(pool.log[0].text.startsWith('insert into public.leads (email, domain, consent_granted_at, consent_text_version)'));
  assert.deepEqual(pool.log[0].params, ['a@gmail.com', 'gmail.com', '2026-09-11T00:00:00.000Z', CONSENT_TEXT_VERSION]);
  assert.ok(pool.log[1].text.startsWith('insert into gdg.leads'));
  assert.equal(pool.log[1].params[1], 'uuid-1');
  assert.ok(pool.log[1].params.includes(CONSENT_TEXT));
  done();
});

test('leadsRepo.create without consent leaves consent fields null, and survives a public.leads failure', async () => {
  const pool = fakePool((t) => {
    if (t.startsWith('insert into public.leads')) throw new Error('boom');
    return [];
  });
  const done = withFakeDb(pool);
  const rec = await leadsRepo.create({ leadId: 'IXL-GDG-2', email: 'a@gmail.com', domain: 'gmail.com', consent: false, createdAt: '2026-09-11T00:00:00.000Z' });
  assert.equal(rec.publicLeadId, null);
  const lead = pool.log.find((l) => l.text.startsWith('insert into gdg.leads'));
  assert.equal(lead.params[1], null, 'no public lead id');
  assert.equal(lead.params[8], false, 'consent');
  assert.equal(lead.params[9], null, 'consent_granted_at');
  assert.equal(lead.params[10], null, 'consent_text');
  done();
});

test('leadsRepo.update maps camelCase to columns; findOwned scopes to the email; markEmailSent stamps public.leads', async () => {
  const pool = fakePool();
  const done = withFakeDb(pool);
  await leadsRepo.update('IXL-GDG-1', { leadStatus: 'completed', runId: 'abc', dotVariantCount: 12, rowNumber: 47, variantCount: '' });
  const upd = pool.log.find((l) => l.text.startsWith('update gdg.leads'));
  for (const col of ['lead_status', 'run_id', 'dot_variant_count', 'sheet_row_number', 'variant_count']) {
    assert.match(upd.text, new RegExp(`${col} = \\$\\d`));
  }
  assert.ok(upd.params.includes(null), "'' is stored as null");
  assert.equal(upd.params[upd.params.length - 1], 'IXL-GDG-1');

  await leadsRepo.findOwned('IXL-GDG-1', 'A@Gmail.com');
  assert.ok(pool.log.some((l) => l.text === 'select * from gdg.leads where lead_id = $1 and lower(email) = lower($2)'));

  await leadsRepo.markEmailSent('IXL-GDG-1');
  assert.ok(pool.log.some((l) => l.text.startsWith('update gdg.leads set results_emailed_at = now()')));
  assert.ok(pool.log.some((l) => l.text.startsWith('update public.leads set report_email_sent_at = now()')));
  done();
});

test('exports and events rows', async () => {
  const pool = fakePool();
  const done = withFakeDb(pool);
  await exportsRepo.record({ runId: 'r1', leadId: 'L1', kind: 'auto_email', recipient: 'a@gmail.com', ok: false, error: 'x'.repeat(900) });
  const exp = pool.log.find((l) => l.text.startsWith('insert into gdg.exports'));
  assert.deepEqual(exp.params.slice(0, 5), ['r1', 'L1', 'auto_email', 'a@gmail.com', false]);
  assert.equal(exp.params[5].length, 500, 'error truncated');
  await eventsRepo.record('r1', 'generate', { durationMs: 2 });
  const ev = pool.log.find((l) => l.text.startsWith('insert into gdg.events'));
  assert.deepEqual(ev.params, ['r1', 'generate', '{"durationMs":2}']);
  done();
});

test('repositories are no-ops without DATABASE_URL', async () => {
  delete process.env.DATABASE_URL;
  setPoolForTests({ query: () => { throw new Error('must not be called'); }, connect: () => { throw new Error('must not be called'); } });
  assert.equal(await runsRepo.saveReport(report()), null);
  assert.equal(await leadsRepo.update('L1', { leadStatus: 'completed' }), null);
  assert.equal(await leadsRepo.findOwned('L1', 'a@gmail.com'), null);
  const lead = { leadId: 'L1', email: 'a@gmail.com' };
  assert.equal(await leadsRepo.create(lead), lead);
  await leadsRepo.markEmailSent('L1');
  await exportsRepo.record({ kind: 'auto_email', ok: true });
  await eventsRepo.record('r1', 'done');
  setPoolForTests(null);
});
