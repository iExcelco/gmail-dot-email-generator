// One visit = one lead + one run. Order: capture the lead (DB, then the sheet row),
// rebuild the run server-side and save it in one transaction, then finalize the same
// lead row in the DB and the sheet. The DB and the sheet are best-effort from the
// visitor's point of view: a failure is logged (and recorded as an event), never thrown.
import crypto from 'node:crypto';
import { buildVariantSet } from '../gmailDots.js';
import { leadsRepo, runsRepo, exportsRepo, eventsRepo } from './repositories.js';

const APP_VERSION = process.env.APP_VERSION || process.env.K_REVISION || 'local';

export function newRunId() {
  return crypto.randomBytes(8).toString('hex');
}

// The full output of a run: every variant the page showed, in page order.
export function buildRunReport(set, { id, leadId, email, createdAt, durationMs }) {
  const plus = new Set(set.plusVariants);
  const variants = [
    { address: set.primary, kind: 'primary' },
    ...set.extras.map((address) => ({ address, kind: plus.has(address) ? 'plus' : 'dot' }))
  ];
  return {
    id,
    leadId,
    createdAt,
    status: 'completed',
    appVersion: APP_VERSION,
    durationMs,
    input: {
      email,
      mode: set.mode,
      workspaceDomain: set.workspaceDomain,
      isWorkspace: set.isWorkspace,
      plusTags: set.plusTagsUsed
    },
    parsed: { baseLocal: set.parsed.baseLocal, domain: set.parsed.domain, plusTag: set.parsed.plusTag },
    headline: {
      primary: set.primary,
      noDot: set.noDot,
      variantCount: variants.length,
      dotVariantCount: variants.filter((v) => v.kind !== 'plus').length,
      plusVariantCount: set.plusVariants.length
    },
    modeWarning: set.modeWarning,
    variants
  };
}

async function attempt(stage, runId, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(`[${stage}] failed:`, error.message);
    await eventsRepo.record(runId, 'error', { stage, message: error.message });
    return undefined;
  }
}

/**
 * @param {object} record - the sheet record built by the /api/log route
 * @param {object} [options]
 * @param {import('./sheetService.js').SheetService|null} [options.sheetService]
 * @param {string} [options.site] - request host
 * @returns {Promise<{ leadId: string, runId: string|null, logged: boolean }>}
 */
export async function captureLeadAndRun(record, { sheetService = null, site = '' } = {}) {
  const started = Date.now();
  const runId = newRunId();
  const { leadId } = record;

  // 1. Capture.
  await eventsRepo.record(runId, 'capture', { leadId, mode: record.mode, isWorkspace: record.isWorkspace === 'yes' });
  const lead = await attempt('db_lead', runId, () => leadsRepo.create({
    leadId,
    email: record.inputEmail,
    domain: record.domain,
    baseLocal: record.baseLocal,
    plusTag: record.plusTag,
    site,
    consent: record.consent === 'yes',
    isWorkspace: record.isWorkspace === 'yes',
    workspaceDomain: record.workspaceDomain,
    userAgent: record.userAgent,
    ip: record.ip,
    createdAt: record.timestamp
  }));

  let rowNumber = null;
  let logged = false;
  if (sheetService) {
    try {
      rowNumber = await sheetService.appendRow({ ...record, leadStatus: 'started', runId });
      logged = true;
      await eventsRepo.record(runId, 'sheet_append', { rowNumber });
    } catch (error) {
      console.error('[sheets] append failed:', error.message);
      await eventsRepo.record(runId, 'error', { stage: 'sheet_append', message: error.message });
    }
    if (rowNumber) await attempt('db_lead', runId, () => leadsRepo.update(leadId, { rowNumber }));
    // Cross-tool lead sync ("[data] all-leads").
    const synced = await attempt('all_leads_append', runId, () => sheetService.appendAllLeadsRow(record));
    if (synced) await eventsRepo.record(runId, 'all_leads_append', null);
  } else {
    // Visibility: when sheets isn't configured we still want to see what
    // would have been written.
    console.log('[sheets:disabled] would-log lead:', JSON.stringify(record));
  }

  // 2. Run. The page generated these client-side; rebuild them here with the same
  // function so the saved run is exactly what the visitor saw.
  let report = null;
  try {
    const t = Date.now();
    const set = buildVariantSet(record.inputEmail, {
      mode: record.mode,
      workspaceDomain: record.workspaceDomain,
      plusTags: record.plusTagsUsed
    });
    if (!set) throw new Error('address did not parse');
    report = buildRunReport(set, {
      id: runId,
      leadId,
      email: record.inputEmail,
      createdAt: record.timestamp,
      durationMs: Date.now() - t
    });
    const h = report.headline;
    await eventsRepo.record(runId, 'generate', {
      durationMs: report.durationMs,
      variantCount: h.variantCount,
      dotVariantCount: h.dotVariantCount,
      plusVariantCount: h.plusVariantCount,
      modeWarning: report.modeWarning || null
    });
  } catch (error) {
    console.error('[run] generate failed:', error.message);
    await eventsRepo.record(runId, 'error', { stage: 'generate', message: error.message });
  }
  if (report) {
    // Only link the lead if its row exists, or the foreign key would sink the whole save.
    const saved = await attempt('db_run', runId, () => runsRepo.saveReport(report, { leadId: lead ? leadId : null }));
    if (saved) await eventsRepo.record(runId, 'saved', { variants: report.variants.length });
  }

  // 3. Finalize the same lead row in the DB and the sheet.
  const status = report ? 'completed' : 'failed';
  const h = report?.headline || {};
  await attempt('db_lead', runId, () => leadsRepo.update(leadId, {
    leadStatus: status,
    runId: report ? runId : '',
    variantCount: h.variantCount,
    dotVariantCount: h.dotVariantCount,
    plusVariantCount: h.plusVariantCount
  }));
  if (sheetService && rowNumber) {
    const updated = await attempt('sheet_update', runId, () => sheetService.updateFields(rowNumber, {
      leadStatus: status,
      runId: report ? runId : '',
      dotVariantCount: h.dotVariantCount ?? ''
    }));
    if (updated) await eventsRepo.record(runId, 'sheet_update', { rowNumber });
  }
  await eventsRepo.record(runId, 'done', { status, durationMs: Date.now() - started });

  return { leadId, runId: report ? runId : null, logged };
}

/**
 * Records the results email (success or failure) against the lead's run, and marks the
 * lead emailed in the DB (own schema + public.leads) and the sheet. `leadId` comes from
 * the browser, so it is only trusted when it belongs to the recipient address.
 */
export async function recordResultsEmail({ leadId, email, ok, error = null }, { sheetService = null } = {}) {
  const lead = await attempt('db_export', null, () => leadsRepo.findOwned(leadId, email));
  const runId = lead?.run_id || null;
  await exportsRepo.record({ runId, leadId: lead?.lead_id || null, kind: 'auto_email', recipient: email, ok, error });
  if (!lead) return;
  if (ok) await attempt('db_export', runId, () => leadsRepo.markEmailSent(lead.lead_id));
  if (sheetService && lead.sheet_row_number) {
    await attempt('sheet_update', runId, () => sheetService.updateFields(lead.sheet_row_number, { resultsEmailed: ok ? 'yes' : 'failed' }));
  }
}
