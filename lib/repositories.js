// Every record the tool generates, written to Postgres (schema `gdg`). All functions are
// safe to call without a database (they return null / do nothing) so the tool keeps working.
import { isDbEnabled, query, withTransaction } from './db.js';

const j = (v) => JSON.stringify(v ?? null);

// Wording shown with the "Email me the list" button, which is how consent is given.
// Bump the version when the text changes.
export const CONSENT_TEXT = 'Email me the list. Sends your addresses plus occasional tips from iExcel.';
export const CONSENT_TEXT_VERSION = 'gdg-2026-09-23';

// ------------------------------------------------------------------ leads
export const leadsRepo = {
  async create(lead) {
    if (!isDbEnabled()) return lead;
    const consentGrantedAt = lead.consent ? lead.createdAt : null;
    let publicLeadId = null;
    try {
      const r = await query(
        `insert into public.leads (email, domain, consent_granted_at, consent_text_version)
         values ($1, $2, $3, $4) returning id`,
        [lead.email, lead.domain, consentGrantedAt, lead.consent ? CONSENT_TEXT_VERSION : null]
      );
      publicLeadId = r.rows[0]?.id || null;
    } catch (error) {
      console.error('[db] public.leads insert failed (continuing):', error.message);
    }
    await query(
      `insert into gdg.leads (lead_id, public_lead_id, email, domain, base_local, plus_tag, site, lead_status, consent,
         consent_granted_at, consent_text, is_workspace, workspace_domain, user_agent, ip, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
       on conflict (lead_id) do nothing`,
      [lead.leadId, publicLeadId, lead.email, lead.domain, lead.baseLocal || null, lead.plusTag || null, lead.site || null,
        lead.leadStatus || 'started', !!lead.consent, consentGrantedAt, lead.consent ? CONSENT_TEXT : null,
        !!lead.isWorkspace, lead.workspaceDomain || null, lead.userAgent || null, lead.ip || null, lead.createdAt]
    );
    return { ...lead, publicLeadId };
  },

  async update(leadId, updates) {
    if (!isDbEnabled()) return null;
    const map = {
      leadStatus: 'lead_status', rowNumber: 'sheet_row_number', runId: 'run_id',
      variantCount: 'variant_count', dotVariantCount: 'dot_variant_count', plusVariantCount: 'plus_variant_count'
    };
    const sets = [];
    const vals = [];
    for (const [k, col] of Object.entries(map)) {
      if (updates[k] === undefined) continue;
      vals.push(updates[k] === '' ? null : updates[k]);
      sets.push(`${col} = $${vals.length}`);
    }
    if (!sets.length) return null;
    vals.push(leadId);
    const r = await query(`update gdg.leads set ${sets.join(', ')}, updated_at = now() where lead_id = $${vals.length} returning *`, vals);
    return r.rows[0] || null;
  },

  // The lead, only if it belongs to `email` — the id comes from the browser, so it must not
  // let anyone mark someone else's lead.
  async findOwned(leadId, email) {
    if (!isDbEnabled() || !leadId || !email) return null;
    const r = await query('select * from gdg.leads where lead_id = $1 and lower(email) = lower($2)', [leadId, email]);
    return r.rows[0] || null;
  },

  // Consent given after capture (the visitor clicked "Email me the list").
  async grantConsent(leadId) {
    if (!isDbEnabled()) return;
    await query(
      `update gdg.leads set consent = true, consent_granted_at = coalesce(consent_granted_at, now()), consent_text = $2, updated_at = now()
       where lead_id = $1`,
      [leadId, CONSENT_TEXT]
    );
    await query(
      `update public.leads set consent_granted_at = coalesce(consent_granted_at, now()), consent_text_version = $2
       where id = (select public_lead_id from gdg.leads where lead_id = $1)`,
      [leadId, CONSENT_TEXT_VERSION]
    ).catch((e) => console.error('[db] public.leads consent update failed:', e.message));
  },

  async markEmailSent(leadId) {
    if (!isDbEnabled()) return;
    await query('update gdg.leads set results_emailed_at = now(), updated_at = now() where lead_id = $1', [leadId]);
    await query(
      'update public.leads set report_email_sent_at = now() where id = (select public_lead_id from gdg.leads where lead_id = $1)',
      [leadId]
    ).catch((e) => console.error('[db] public.leads email-sent update failed:', e.message));
  }
};

// ------------------------------------------------------------------ runs (the full output, exploded)
export function runRowsFromReport(report, { leadId = null } = {}) {
  const h = report.headline || {};
  const run = {
    id: report.id, lead_id: leadId, email: report.input.email, domain: report.parsed.domain, base_local: report.parsed.baseLocal,
    mode: report.input.mode, is_workspace: !!report.input.isWorkspace, workspace_domain: report.input.workspaceDomain || null,
    plus_tags: report.input.plusTags || [], primary_variant: h.primary || null, no_dot_variant: h.noDot || null,
    variant_count: h.variantCount, dot_variant_count: h.dotVariantCount, plus_variant_count: h.plusVariantCount,
    mode_warning: report.modeWarning || null, status: report.status || 'completed', duration_ms: report.durationMs ?? null,
    app_version: report.appVersion || null
  };
  const variants = (report.variants || []).map((v, i) => ({ position: i, address: v.address, kind: v.kind }));
  return { run, variants };
}

export const runsRepo = {
  async saveReport(report, opts = {}) {
    if (!isDbEnabled() || !report?.id) return null;
    const { run, variants } = runRowsFromReport(report, opts);
    await withTransaction(async (c) => {
      await c.query(
        `insert into gdg.runs (id, lead_id, email, domain, base_local, mode, is_workspace, workspace_domain, plus_tags, primary_variant,
           no_dot_variant, variant_count, dot_variant_count, plus_variant_count, mode_warning, status, duration_ms, report, app_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         on conflict (id) do update set report = excluded.report, lead_id = coalesce(excluded.lead_id, gdg.runs.lead_id)`,
        [run.id, run.lead_id, run.email, run.domain, run.base_local, run.mode, run.is_workspace, run.workspace_domain, j(run.plus_tags),
          run.primary_variant, run.no_dot_variant, run.variant_count, run.dot_variant_count, run.plus_variant_count, run.mode_warning,
          run.status, run.duration_ms, j(report), run.app_version]
      );
      await c.query('delete from gdg.variants where run_id = $1', [run.id]);
      // One statement for the whole list: all mode can produce tens of thousands of variants.
      await c.query(
        `insert into gdg.variants (run_id, position, address, kind)
         select $1, t.position, t.address, t.kind from unnest($2::int[], $3::text[], $4::text[]) as t(position, address, kind)`,
        [run.id, variants.map((v) => v.position), variants.map((v) => v.address), variants.map((v) => v.kind)]
      );
    });
    return run.id;
  }
};

// ------------------------------------------------------------------ exports + events
export const exportsRepo = {
  async record({ runId = null, leadId = null, kind, recipient = null, ok, error = null }) {
    if (!isDbEnabled()) return;
    await query('insert into gdg.exports (run_id, lead_id, kind, recipient, ok, error) values ($1,$2,$3,$4,$5,$6)',
      [runId, leadId, kind, recipient, !!ok, error ? String(error).slice(0, 500) : null])
      .catch((e) => console.error('[db] exports insert failed:', e.message));
  }
};

export const eventsRepo = {
  async record(runId, stage, payload = null) {
    if (!isDbEnabled()) return;
    await query('insert into gdg.events (run_id, stage, payload) values ($1,$2,$3)', [runId, stage, j(payload)])
      .catch((e) => console.error('[db] events insert failed:', e.message));
  }
};
