// Postgres (Neon) connection. No-op when DATABASE_URL is unset so local dev and
// tests never need a database. Every write path must tolerate `isDbEnabled() === false`.
import pg from 'pg';

let pool = null;

export function isDbEnabled() {
  return !!process.env.DATABASE_URL;
}

export function getPool() {
  if (!isDbEnabled()) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
      ssl: /sslmode=require|neon\.tech/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined
    });
    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  }
  return pool;
}

// For tests: inject a fake pool ({ query, connect }).
export function setPoolForTests(fake) {
  pool = fake;
}

export async function query(text, params = []) {
  const p = getPool();
  if (!p) return { rows: [], rowCount: 0 };
  return p.query(text, params);
}

export async function withTransaction(fn) {
  const p = getPool();
  if (!p) return fn({ query: async () => ({ rows: [], rowCount: 0 }) });
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}
