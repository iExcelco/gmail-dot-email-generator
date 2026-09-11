// Cloudflare Workers entrypoint for the Gmail Dot Variations Generator (GDV).
//
// This is the fetch-handler counterpart to server.js (Express / Cloud Run).
// It reuses the SAME runtime-agnostic core (lib/core.js) so both runtimes run
// byte-identical validation / logging logic. The only runtime-specific pieces
// are injected here:
//   - Google Sheets persistence  -> lib/sheetsRest.js (WebCrypto JWT + REST),
//     replacing the googleapis + ADC path that cannot run on Workers.
//   - Email delivery             -> email-service.js (AgentMail, fetch-based,
//     already Workers-compatible), with the API key passed from `env`.
//   - Static HTML                -> Workers Static Assets ("ASSETS" binding),
//     replacing server.js's node:fs read of service-page.html.
//
// Routing (base paths, the /api/* routes, and the 301 from the old canonical
// slug) mirrors server.js exactly and is driven at RUNTIME by env vars:
//   APP_BASE_PATH            e.g. "/gmail-dot-trick" (prefixed) or "/" (vanity)
//   APP_LEGACY_BASE_PATHS    comma-separated legacy base paths, optional
// Nothing is baked in at build time, so a single build serves both deployments.

import { handleLog, handleSendResults } from '../lib/core.js';
import { generateLeadId } from '../lib/sheetSchema.js';
import { SheetServiceRest } from '../lib/sheetsRest.js';
import { sendResultsEmail } from '../email-service.js';

// Per-isolate cache of the Sheets client so repeated requests reuse the parsed
// credentials and the in-memory access token. Keyed by spreadsheet+tab so a
// config change rebuilds it.
let sheetServiceCache = null;
let sheetServiceCacheKey = null;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

// Mirror server.js: BASE_PATHS = unique([APP_BASE_PATH || '/', ...legacy]).
function computeBasePaths(env) {
  const primary = env.APP_BASE_PATH || '/';
  const legacy = (env.APP_LEGACY_BASE_PATHS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([primary, ...legacy])];
}

// The API route path for a given base path, matching server.js:
//   bp === '/'  ->  '/api/log'
//   otherwise   ->  `${bp without trailing slash}/api/log`
function apiPath(bp, suffix) {
  const prefix = bp === '/' ? '' : bp.replace(/\/$/, '');
  return `${prefix}${suffix}`;
}

// Build the resolved SheetServiceRest for this env, or null when persistence is
// not configured. Returning null makes handleLog take its "disabled" branch
// (logs the would-write record, returns logged:false) — the same observable
// result as server.js when GOOGLE_SHEETS_SPREADSHEET_ID is unset.
function getSheetService(env) {
  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) return null;

  const tabName = env.GOOGLE_SHEETS_TAB || 'gmail-email-generator';
  const rawKey = env.GOOGLE_SA_KEY;
  if (!rawKey) {
    console.warn('[sheets] GOOGLE_SA_KEY not set — /api/log will accept but not persist.');
    return null;
  }

  const cacheKey = `${spreadsheetId}|${tabName}`;
  if (sheetServiceCache && sheetServiceCacheKey === cacheKey) return sheetServiceCache;

  let credentials;
  try {
    credentials = typeof rawKey === 'string' ? JSON.parse(rawKey) : rawKey;
  } catch (error) {
    console.error('[sheets] GOOGLE_SA_KEY is not valid JSON:', error.message);
    return null;
  }

  sheetServiceCache = new SheetServiceRest({ spreadsheetId, tabName, credentials });
  sheetServiceCacheKey = cacheKey;
  return sheetServiceCache;
}

// Parse a JSON body defensively. An empty or malformed body becomes {} so the
// core validators return a 400 ("email required") rather than throwing — an
// empty POST must NOT be a silent success.
async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function handleLogRequest(request, env) {
  const body = await readJsonBody(request);
  const userAgent = request.headers.get('user-agent') || '';
  // Prefer the standard forwarded header (first hop), then Cloudflare's
  // connecting-IP. Mirrors server.js's x-forwarded-for -> req.ip fallback.
  const ip =
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    request.headers.get('cf-connecting-ip') ||
    '';

  const sheetService = getSheetService(env);

  const { status, body: resBody } = await handleLog(
    { body, userAgent, ip },
    {
      generateLeadId,
      appendRow: sheetService ? (record) => sheetService.appendRow(record) : null,
      onDisabled: (record) =>
        console.log('[sheets:disabled] would-log lead:', JSON.stringify(record))
    }
  );

  return jsonResponse(status, resBody);
}

async function handleSendResultsRequest(request, env) {
  const body = await readJsonBody(request);

  const { status, body: resBody } = await handleSendResults(
    { body },
    {
      // AgentMail key/inbox come from env (Workers don't populate process.env
      // from secrets); email-service.js falls back to its defaults otherwise.
      sendEmail: (args) =>
        sendResultsEmail({
          ...args,
          apiKey: env.AGENTMAIL_API_KEY,
          inboxId: env.AGENTMAIL_INBOX_ID
        })
    }
  );

  return jsonResponse(status, resBody);
}

// Serve service-page.html via the ASSETS binding. The file lives at the root of
// the assets directory (public/service-page.html), so it is addressable at
// "/service-page.html" regardless of the app's base path.
function serveHtml(request, env) {
  const origin = new URL(request.url).origin;
  return env.ASSETS.fetch(new Request(`${origin}/service-page.html`, { method: 'GET' }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // 1) 301 redirect the old canonical slug to the new one. Defined FIRST so
    //    it always wins, preserving SEO equity from the prior canonical URL.
    if ((method === 'GET' || method === 'HEAD') &&
        /^\/gmail-dot-variations-generator(\/.*)?$/.test(pathname)) {
      const target =
        (pathname + url.search).replace('/gmail-dot-variations-generator', '/gmail-dot-trick');
      return Response.redirect(new URL(target, url.origin).toString(), 301);
    }

    const basePaths = computeBasePaths(env);

    // 2) API routes (POST). server.js registers `${bp}/api/*` for every base
    //    path, plus a bare `/api/*` fallback when '/' isn't already a base path.
    if (method === 'POST') {
      const apiBases = basePaths.includes('/') ? basePaths : [...basePaths, '/'];
      for (const bp of apiBases) {
        if (pathname === apiPath(bp, '/api/log')) return handleLogRequest(request, env);
        if (pathname === apiPath(bp, '/api/send-results')) return handleSendResultsRequest(request, env);
      }
    }

    // 3) HTML at each REAL base path (and its trailing-slash form for non-root
    //    paths) — exactly the GET routes server.js registers. Note: unlike the
    //    API fallback, HTML is NOT served at '/' unless '/' is an actual base
    //    path (so the prefixed deployment does not answer "/" with the page).
    if (method === 'GET' || method === 'HEAD') {
      for (const bp of basePaths) {
        const norm = bp === '/' ? '/' : bp.replace(/\/$/, '');
        if (pathname === norm || (norm !== '/' && pathname === `${norm}/`)) {
          return serveHtml(request, env);
        }
      }

      // 4) Anything else: defer to static assets (self-contained page assets,
      //    /service-page.html direct, etc.). Unlike server.js's
      //    express.static(__dirname), only files under public/ are exposed —
      //    source files are never served.
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) return assetResponse;
    }

    return new Response('Not Found', { status: 404 });
  }
};
