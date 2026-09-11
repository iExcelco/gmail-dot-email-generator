// Copies the static page into the Workers Static Assets directory (public/).
//
// The single source of truth for the page is service-page.html at the repo
// root (served by Cloud Run's express.static). The Cloudflare Worker serves it
// via the ASSETS binding, whose directory is ./public. Rather than duplicate
// the file in git (which would drift), we generate public/ from the root file
// before `wrangler dev` / `wrangler deploy`. public/ is git-ignored.
//
// Run automatically by the `cf:dev` / `cf:deploy` npm scripts. Safe to re-run.

import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(repoRoot, 'public');

// Files copied from repo root into public/. Only the self-contained page today;
// add more here if the page ever references sibling static assets.
const ASSETS = ['service-page.html'];

await mkdir(publicDir, { recursive: true });
for (const name of ASSETS) {
  await copyFile(path.join(repoRoot, name), path.join(publicDir, name));
  console.log(`[cf:sync] ${name} -> public/${name}`);
}
console.log(`[cf:sync] done (${ASSETS.length} file${ASSETS.length === 1 ? '' : 's'})`);
