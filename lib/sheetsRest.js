// Runtime-agnostic Google Sheets client for Cloudflare Workers.
//
// The Workers runtime has WebCrypto (`crypto.subtle`) and a global `fetch`, but
// NO Node built-ins, NO `googleapis`, and NO npm imports. So instead of the
// Cloud Run googleapis + Application Default Credentials path, this module
// hand-rolls the service-account flow:
//
//   1. RS256-sign a JWT with the service account's PKCS#8 private key.
//   2. Exchange the JWT for a short-lived OAuth access token.
//   3. Call the Sheets v4 REST `values` endpoints with that bearer token.
//
// The column layout, A1 range math, and record->row mapping are shared with the
// Cloud Run path via ./sheetSchema.js so the two runtimes can never drift.

import { HEADERS, LAST_COLUMN_LETTER, COLUMN_RANGE, recordToRow } from './sheetSchema.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// Shared in-memory access-token cache, keyed by service-account client_email.
// In a Worker this persists for the lifetime of the isolate, so repeated
// requests reuse the same token until it is ~60s from expiry. Each entry is
// `{ accessToken, expiresAt }` (expiresAt is epoch ms).
const tokenCache = new Map();

// ---------------------------------------------------------------------------
// Base64 / Base64URL helpers
// ---------------------------------------------------------------------------

// Base64URL-encode a string or binary buffer.
//   - string  -> UTF-8 bytes -> base64url
//   - ArrayBuffer / Uint8Array -> raw bytes -> base64url
// base64url = standard base64 with `+`->`-`, `/`->`_`, and `=` padding stripped.
export function base64url(input) {
  let bytes;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (ArrayBuffer.isView(input)) {
    // Any other typed-array / DataView view over a buffer.
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else {
    throw new TypeError('base64url expects a string, ArrayBuffer, or ArrayBuffer view');
  }

  // Build a binary string for btoa. Chunk to avoid blowing the call stack on
  // large inputs (signatures are small, but this keeps the helper general).
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Private-key import (PKCS#8 PEM -> CryptoKey)
// ---------------------------------------------------------------------------

// Import a PKCS#8 PEM private key ("-----BEGIN PRIVATE KEY-----...") as an
// RSASSA-PKCS1-v1_5 / SHA-256 signing CryptoKey.
export async function importPrivateKey(pem) {
  if (typeof pem !== 'string' || !pem.includes('BEGIN PRIVATE KEY')) {
    throw new Error('importPrivateKey expects a PKCS#8 PEM string');
  }

  // Strip the PEM header/footer and ALL whitespace/newlines, leaving pure
  // base64, then decode to DER bytes via atob.
  const b64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');

  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

// ---------------------------------------------------------------------------
// JWT construction + OAuth token exchange
// ---------------------------------------------------------------------------

// Build and RS256-sign a service-account JWT asserting the Sheets scope.
async function buildSignedJwt(credentials) {
  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: credentials.client_email,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    iat,
    exp: iat + 3600
  };

  const headerB64 = base64url(JSON.stringify(header));
  const claimB64 = base64url(JSON.stringify(claim));
  const signingInput = `${headerB64}.${claimB64}`;

  const key = await importPrivateKey(credentials.private_key);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64url(signature)}`;
}

// Obtain an access token for the given service-account credentials, using the
// shared in-memory cache keyed by client_email. Returns { accessToken, expiresAt }.
export async function getAccessToken(credentials) {
  if (!credentials || !credentials.client_email || !credentials.private_key) {
    throw new Error('getAccessToken requires credentials with client_email and private_key');
  }

  const cacheKey = credentials.client_email;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached;
  }

  const jwt = await buildSignedJwt(credentials);

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token exchange failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  // Refresh ~60s before the real expiry to avoid using a token mid-flight that
  // expires server-side before our request lands.
  const expiresAt = Date.now() + data.expires_in * 1000 - 60000;
  const entry = { accessToken: data.access_token, expiresAt };
  tokenCache.set(cacheKey, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Sheets v4 REST value operations
// ---------------------------------------------------------------------------

function valuesBaseUrl(spreadsheetId, range) {
  return `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
}

// Shared error handling: throw with status + body on any non-2xx response.
async function assertOk(res, label) {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${label} failed: ${res.status} ${text}`);
  }
  return res;
}

async function sheetsGet({ spreadsheetId, range, accessToken }) {
  const res = await fetch(valuesBaseUrl(spreadsheetId, range), {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  await assertOk(res, 'Sheets values.get');
  return res.json();
}

async function sheetsUpdate({ spreadsheetId, range, values, accessToken }) {
  const url = `${valuesBaseUrl(spreadsheetId, range)}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values })
  });
  await assertOk(res, 'Sheets values.update');
  return res.json();
}

async function sheetsAppend({ spreadsheetId, range, values, accessToken }) {
  const url = `${valuesBaseUrl(spreadsheetId, range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values })
  });
  await assertOk(res, 'Sheets values.append');
  return res.json();
}

// ---------------------------------------------------------------------------
// Public API — parity with the Cloud Run SheetService class
// ---------------------------------------------------------------------------

export class SheetServiceRest {
  constructor({ spreadsheetId, tabName, credentials }) {
    this.spreadsheetId = spreadsheetId;
    this.tabName = tabName;
    this.credentials = credentials;
    this.headersEnsured = false;
    this.initPromise = null;
  }

  // Resolve a current access token for this instance's credentials.
  async #accessToken() {
    const { accessToken } = await getAccessToken(this.credentials);
    return accessToken;
  }

  // Idempotent. Ensures the header row exists exactly once per instance,
  // mirroring the Cloud Run SheetService.ensureInitialized() semantics:
  //   - throw if spreadsheetId or tabName is missing;
  //   - read A1:<last>1; if empty OR shorter than HEADERS, write HEADERS to A1;
  //   - otherwise leave the existing header row alone;
  //   - de-dupe concurrent callers via initPromise, and reset it to null on
  //     failure so a later call can retry.
  async ensureInitialized() {
    if (this.headersEnsured) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      if (!this.spreadsheetId || !this.tabName) {
        throw new Error('SheetServiceRest missing spreadsheetId or tabName');
      }

      const accessToken = await this.#accessToken();

      const existing = await sheetsGet({
        spreadsheetId: this.spreadsheetId,
        range: `${this.tabName}!A1:${LAST_COLUMN_LETTER}1`,
        accessToken
      });

      const existingRow = (existing.values && existing.values[0]) || [];
      const hasHeaders = existingRow.length > 0;

      // Write headers when the row is empty, or extend it in place when a
      // prior version created the sheet with fewer columns. We never truncate
      // or rewrite existing data rows.
      if (!hasHeaders || existingRow.length < HEADERS.length) {
        await sheetsUpdate({
          spreadsheetId: this.spreadsheetId,
          range: `${this.tabName}!A1`,
          values: [HEADERS],
          accessToken
        });
      }

      this.headersEnsured = true;
      return true;
    })().catch((error) => {
      this.initPromise = null;
      throw error;
    });

    return this.initPromise;
  }

  // Ensure the header row exists, then append the record as a new row. Returns
  // the parsed JSON response from the Sheets append call.
  async appendRow(record) {
    await this.ensureInitialized();

    const row = recordToRow(record);
    const accessToken = await this.#accessToken();

    const data = await sheetsAppend({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tabName}!${COLUMN_RANGE}`,
      values: [row],
      accessToken
    });

    return data;
  }
}
