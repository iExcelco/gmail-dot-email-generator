// Runtime-agnostic core for the Gmail Dot Generator's two API routes.
//
// This module holds the exact request-handling logic that previously lived
// inline in server.js's `logRoute` and `sendResultsRoute`, factored out so
// BOTH runtime adapters call identical code:
//   - the Express / Cloud Run adapter (server.js)
//   - the Cloudflare Workers adapter
//
// It has NO dependency on Express, Node built-ins, googleapis, or any runtime
// global beyond `Date`. Everything runtime-specific — lead-id generation, the
// sheet append, the disabled-sheets logging, and the email send — is INJECTED
// by the caller via the `deps` argument. The only imports are two pure-JS,
// dependency-free helpers that already exist in the repo.

import { validateEmail } from './emailValidator.js';
import { parseGmailAddress } from '../gmailDots.js';

/**
 * Core logic for POST /api/log.
 *
 * Mirrors the original Express `logRoute` branch-for-branch.
 *
 * @param {object} input
 * @param {*}      input.body      - parsed JSON request body. Non-object (or
 *                                   missing) values are treated as `{}`, the
 *                                   same way `req.body || {}` behaved.
 * @param {string} input.userAgent - user-agent string (adapter supplies it,
 *                                   replacing `req.headers['user-agent']`).
 * @param {string} input.ip        - client IP (adapter computes the
 *                                   x-forwarded-for / req.ip expression;
 *                                   core just uses `(input.ip || '')`).
 * @param {object} deps
 * @param {() => string} deps.generateLeadId - returns a new lead id string.
 * @param {?(record: object) => (Promise<void>|void)} deps.appendRow
 *        - async fn that persists the record, or `null` when sheets logging
 *          is disabled.
 * @param {?(record: object) => void} [deps.onDisabled]
 *        - called with the record when `appendRow` is null (this is where the
 *          adapter emits its `[sheets:disabled]` log). Optional.
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleLog(input, deps) {
  // Treat a missing or non-object body as `{}` — same as `req.body || {}`,
  // but also guarding against non-object JSON (e.g. a bare array or string).
  const rawBody = input && input.body;
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};

  const {
    email,
    mode,
    variantCount,
    firstVariant,
    workspaceDomain,
    isWorkspace,
    plusTagsUsed,
    plusVariantCount,
    consent
  } = body;

  if (typeof email !== 'string' || !email) {
    return { status: 400, body: { ok: false, error: 'email required' } };
  }

  // In Workspace mode we deliberately skip the Gmail-only validateEmail check
  // because the user is using a custom company domain. We still parse the
  // address to make sure it's structurally a valid email and that the local
  // part is gmail-rules-compatible (letters/numbers/dots only).
  const wsDomain = typeof workspaceDomain === 'string' ? workspaceDomain.trim().toLowerCase() : '';
  const useWorkspace = !!isWorkspace && !!wsDomain;

  if (!useWorkspace) {
    const validation = validateEmail(email);
    if (!validation.valid) {
      return { status: 400, body: { ok: false, error: validation.reason } };
    }
  }

  const parsed = parseGmailAddress(email, useWorkspace ? { workspaceDomain: wsDomain } : undefined);
  if (!parsed) {
    return {
      status: 400,
      body: {
        ok: false,
        error: useWorkspace ? 'invalid email for the supplied workspace domain' : 'invalid gmail address'
      }
    };
  }

  const safePlusTags = Array.isArray(plusTagsUsed)
    ? plusTagsUsed.filter((t) => typeof t === 'string').slice(0, 50).join(',')
    : '';

  const record = {
    timestamp: new Date().toISOString(),
    leadId: deps.generateLeadId(),
    inputEmail: email,
    baseLocal: parsed.baseLocal,
    domain: parsed.domain,
    plusTag: parsed.plusTag || '',
    mode: mode === 'all' ? 'all' : 'wordSplit',
    variantCount: Number.isFinite(variantCount) ? variantCount : '',
    firstVariant: typeof firstVariant === 'string' ? firstVariant : '',
    userAgent: (input.userAgent || '').slice(0, 500),
    ip: input.ip || '',
    isWorkspace: useWorkspace ? 'yes' : 'no',
    workspaceDomain: useWorkspace ? wsDomain : '',
    plusTagsUsed: safePlusTags,
    plusVariantCount: Number.isFinite(plusVariantCount) ? plusVariantCount : '',
    consent: consent ? 'yes' : 'no'
  };

  if (deps.appendRow) {
    try {
      await deps.appendRow(record);
    } catch (error) {
      console.error('[sheets] append failed:', error.message);
      return { status: 200, body: { ok: true, leadId: record.leadId, logged: false } };
    }
  } else {
    // Visibility: when sheets isn't configured we still want to see what
    // would have been written. The adapter's onDisabled hook is where the
    // original `[sheets:disabled] would-log lead` console.log happens.
    if (typeof deps.onDisabled === 'function') {
      deps.onDisabled(record);
    }
    return { status: 200, body: { ok: true, leadId: record.leadId, logged: false } };
  }

  // Reached only when appendRow was present and succeeded.
  return { status: 200, body: { ok: true, leadId: record.leadId, logged: true } };
}

/**
 * Core logic for POST /api/send-results.
 *
 * Mirrors the original Express `sendResultsRoute` branch-for-branch, including
 * EMAIL-GDV-500 behavior: an email-send failure never rethrows and never
 * returns a 5xx — the UI already rendered the variations client-side, so we
 * return 200 with `emailQueued: false` and log the failure for ops.
 *
 * @param {object} input
 * @param {*} input.body - parsed JSON request body (non-object treated as `{}`).
 * @param {object} deps
 * @param {(args: { to: string, baseEmail: string, mode: string, variations: any[] }) => Promise<void>} deps.sendEmail
 *        - async fn that sends the results email.
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleSendResults(input, deps) {
  const rawBody = input && input.body;
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};

  const { email, baseEmail, mode, variations, workspaceDomain, isWorkspace } = body;

  if (typeof email !== 'string' || !email) {
    return { status: 400, body: { ok: false, error: 'email required' } };
  }

  // Workspace-mode bypass — mirrors the pattern in /api/log so users on
  // custom Google Workspace domains (e.g. Micah@iexcel.co) can request
  // emailed results without tripping the Gmail-only validator.
  const wsDomain = typeof workspaceDomain === 'string' ? workspaceDomain.trim().toLowerCase() : '';
  const useWorkspace = !!isWorkspace && !!wsDomain;

  if (!useWorkspace) {
    const validation = validateEmail(email);
    if (!validation.valid) {
      return { status: 400, body: { ok: false, error: validation.reason } };
    }
  } else {
    // Light structural sanity check for workspace-mode addresses since we
    // skipped the strict Gmail-only validator above.
    const parsed = parseGmailAddress(email, { workspaceDomain: wsDomain });
    if (!parsed) {
      return {
        status: 400,
        body: {
          ok: false,
          error: 'invalid email for the supplied workspace domain'
        }
      };
    }
  }

  if (!Array.isArray(variations) || variations.length === 0) {
    return { status: 400, body: { ok: false, error: 'variations required' } };
  }

  // EMAIL-GDV-500: Do NOT block the response on email failures. If the mailer
  // is misconfigured or the template throws, we still return 200 so the UI
  // doesn't show a generic 500 to the user — their variations already
  // rendered client-side. We log the failure for ops.
  try {
    await deps.sendEmail({
      to: email,
      baseEmail: baseEmail || email,
      mode: mode || 'wordSplit',
      variations
    });
    return { status: 200, body: { ok: true, emailQueued: true } };
  } catch (error) {
    console.error('[email] send failed:', {
      message: error && error.message,
      name: error && error.name,
      stack: error && error.stack,
      to: email,
      mode,
      variationCount: variations.length
    });
    return { status: 200, body: { ok: true, emailQueued: false } };
  }
}
