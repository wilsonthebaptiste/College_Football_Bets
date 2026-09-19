/**
 * Proves no privileged Supabase key ships in a built bundle (plan §5.2: "grep
 * the deployed Worker bundle to confirm no service-role key is present").
 *
 * The repo never holds the service-role key (src/db/client.ts explains why),
 * so this is a tripwire for the day someone pastes one into a config file, a
 * `.env` that a build reads, or a hard-coded fallback. It scans what is
 * actually deployed, not the source:
 *
 *   npm run bundle --workspace @cfb/api     # the Worker, exactly as `wrangler deploy` would upload it
 *   npm run build:web                       # the site, exactly as Pages would serve it
 *   node scripts/check-bundle-secrets.mjs apps/api/dist apps/web/dist
 *
 * What counts as a leak:
 *   - a new-style secret key:   sb_secret_…
 *   - a legacy JWT key whose payload says  "role": "service_role"
 *   - the variable name SUPABASE_SERVICE_ROLE_KEY in shipped code (source maps
 *     are skipped for this one: they carry comments that name it on purpose)
 *
 * The anon/publishable key is expected in the web bundle: it is public by
 * design, and RLS is the boundary (§31). It is reported, not failed.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.json', '.map', '.txt']);

async function* files(path) {
  const info = await stat(path);
  if (info.isFile()) {
    yield path;
    return;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) yield* files(child);
    else if (TEXT_EXTENSIONS.has(extname(entry.name))) yield child;
  }
}

function decodeSegment(segment) {
  try {
    const json = Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g;
const SECRET_KEY = /sb_secret_[A-Za-z0-9_-]{8,}/g;
const PUBLISHABLE_KEY = /sb_publishable_[A-Za-z0-9_-]{8,}/g;

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('Usage: node scripts/check-bundle-secrets.mjs <dir-or-file> [...]');
  process.exit(2);
}

const leaks = [];
const notes = [];
let scanned = 0;

for (const root of roots) {
  try {
    await stat(root);
  } catch {
    console.error(`Not found: ${root}. Build it first (see the header of this script).`);
    process.exit(2);
  }
  for await (const file of files(root)) {
    scanned += 1;
    const text = await readFile(file, 'utf8');

    for (const match of text.matchAll(SECRET_KEY)) {
      leaks.push(`${file}: a Supabase secret key (${match[0].slice(0, 14)}…)`);
    }
    for (const match of text.matchAll(JWT)) {
      const payload = decodeSegment(match[1]);
      if (payload?.role === 'service_role') {
        leaks.push(`${file}: a JWT with role "service_role" (${match[0].slice(0, 16)}…)`);
      } else if (payload?.role === 'anon') {
        notes.push(`${file}: the anon key (public by design)`);
      }
    }
    if (!file.endsWith('.map') && text.includes('SUPABASE_SERVICE_ROLE_KEY')) {
      leaks.push(`${file}: names SUPABASE_SERVICE_ROLE_KEY`);
    }
    if (PUBLISHABLE_KEY.test(text)) notes.push(`${file}: the publishable key (public by design)`);
    PUBLISHABLE_KEY.lastIndex = 0;
  }
}

for (const note of new Set(notes)) console.log(`  · ${note}`);
if (leaks.length > 0) {
  console.error(`\n✗ ${String(leaks.length)} privileged key(s) found in ${String(scanned)} files:`);
  for (const leak of leaks) console.error(`  • ${leak}`);
  console.error('\nDo not deploy. Remove the key, rotate it in Supabase, and rebuild.');
  process.exit(1);
}
console.log(`✓ No service-role or secret key in ${String(scanned)} files (${roots.join(', ')}).`);
