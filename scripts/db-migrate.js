#!/usr/bin/env node
// Applies db/migrations/*.sql in order, once each. Tracks applied files in gdg.migrations.
// Usage: DATABASE_URL=... node scripts/db-migrate.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'db', 'migrations');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set; nothing to migrate.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('create schema if not exists gdg');
  await client.query('create table if not exists gdg.migrations (name text primary key, applied_at timestamptz not null default now())');
  const applied = new Set((await client.query('select name from gdg.migrations')).rows.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) { console.log(`= ${file} (already applied)`); continue; }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('insert into gdg.migrations (name) values ($1)', [file]);
      await client.query('COMMIT');
      console.log(`+ ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`${file}: ${error.message}`, { cause: error });
    }
  }
  console.log('migrations complete');
} finally {
  await client.end();
}
