/**
 * Proves the database security model, by talking to PostgREST directly.
 *
 * This is the Phase 1 exit criterion that matters most:
 *
 *   "insert into user_team_selections via raw PostgREST is rejected BY THE
 *    DATABASE (not by the Worker) as both anon and a non-admin token."
 *
 * Note what this script does NOT do: it never calls the Worker. It uses the
 * same anon key a browser would have and constructs requests by hand — which is
 * exactly the attack §30 describes ("a user should not be able to modify data
 * merely by manually constructing a network request"). If the Worker were
 * deleted, every assertion here would still have to hold.
 *
 *   cp .env.example .env    # fill it in
 *   npm run verify:rls
 *
 * Credentials are optional and the script degrades: with only SUPABASE_URL and
 * SUPABASE_ANON_KEY it runs the `anon` matrix and reports what it skipped.
 */

import { readFile } from 'node:fs/promises';

// ─── Config ──────────────────────────────────────────────────────────────────

async function loadEnv() {
  const env = { ...process.env };
  try {
    const text = await readFile('.env', 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match === null) continue;
      const [, key, rawValue] = match;
      const value = rawValue.trim().replace(/^["']|["']$/g, '');
      if (value !== '') env[key] ??= value;
    }
  } catch {
    // No .env file; rely on the process environment.
  }
  return env;
}

const env = await loadEnv();
const SUPABASE_URL = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const ANON_KEY = env.SUPABASE_ANON_KEY ?? '';

if (SUPABASE_URL === '' || ANON_KEY === '') {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required. See .env.example.');
  process.exit(2);
}

const REST = `${SUPABASE_URL}/rest/v1`;
const AUTH = `${SUPABASE_URL}/auth/v1`;

// ─── Tiny assertion harness ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function pass(name, detail = '') {
  passed += 1;
  console.log(`  [32m✓[0m ${name}${detail === '' ? '' : `  ${detail}`}`);
}

function fail(name, detail) {
  failed += 1;
  failures.push(`${name} — ${detail}`);
  console.log(`  [31m✗[0m ${name}\n      ${detail}`);
}

function skip(name, why) {
  skipped += 1;
  console.log(`  [90m·[0m ${name}  (skipped: ${why})`);
}

function section(title) {
  console.log(`\n[1m${title}[0m`);
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function rest(path, { method = 'GET', token = null, body = null, prefer = null } = {}) {
  // Same rule as the Worker's PostgREST client: no user token means no
  // Authorization header, which PostgREST maps to the `anon` role. Works with
  // both legacy JWT anon keys and newer sb_publishable_… keys.
  const headers = {
    apikey: ANON_KEY,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (prefer !== null) headers.Prefer = prefer;

  const response = await fetch(`${REST}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });

  let parsed = null;
  const text = await response.text();
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

async function signIn(email, password) {
  const response = await fetch(`${AUTH}/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.access_token !== 'string') {
    return {
      token: null,
      error: body?.error_description ?? body?.msg ?? `HTTP ${response.status}`,
    };
  }
  return { token: body.access_token, error: null };
}

/** PostgREST signals an RLS/GRANT refusal as 401/403, usually with code 42501. */
function isRefusal(result) {
  return result.status === 401 || result.status === 403;
}

// ─── The matrices ────────────────────────────────────────────────────────────

const TABLES = ['app_users', 'teams', 'user_team_selections'];

async function checkReadsAllowed(label, token) {
  for (const table of TABLES) {
    const result = await rest(`/${table}?select=id&limit=5`, { token });
    if (result.status === 200 && Array.isArray(result.body) && result.body.length > 0) {
      pass(`${label}: SELECT ${table}`, `${result.body.length} row(s)`);
    } else if (result.status === 200) {
      fail(`${label}: SELECT ${table}`, 'allowed but returned no rows — is the seed applied?');
    } else {
      fail(`${label}: SELECT ${table}`, `HTTP ${result.status} ${JSON.stringify(result.body)}`);
    }
  }
}

async function checkAdminsInvisible(label, token) {
  const result = await rest('/admins?select=auth_user_id', { token });
  // Either a hard refusal (no GRANT) or an empty set (RLS, no policy) is correct.
  if (isRefusal(result)) {
    pass(`${label}: SELECT admins refused`, `HTTP ${result.status}`);
  } else if (result.status === 200 && Array.isArray(result.body) && result.body.length === 0) {
    pass(`${label}: SELECT admins returns nothing`, 'RLS with zero policies');
  } else {
    fail(
      `${label}: SELECT admins`,
      `LEAKED — HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 200)}`,
    );
  }
}

async function checkInsertsRefused(label, token, probeUserId, probeTeamId) {
  const attempts = [
    ['app_users', { display_name: '__rls_probe_should_not_exist__' }],
    ['teams', { provider: 'espn', provider_team_id: '__rls_probe__', name: '__rls_probe__' }],
    ['user_team_selections', { user_id: probeUserId, team_id: probeTeamId, selection_order: 24 }],
  ];

  for (const [table, row] of attempts) {
    if (row.user_id === null || row.team_id === null) {
      skip(`${label}: INSERT ${table}`, 'no seeded ids to reference');
      continue;
    }
    const result = await rest(`/${table}`, {
      method: 'POST',
      token,
      body: row,
      prefer: 'return=representation',
    });

    if (isRefusal(result)) {
      pass(`${label}: INSERT ${table} refused`, `HTTP ${result.status}`);
    } else {
      fail(
        `${label}: INSERT ${table}`,
        `NOT REFUSED — HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 200)}`,
      );
    }
  }
}

/**
 * UPDATE and DELETE do not error under RLS — the USING clause simply makes no
 * row visible, and PostgREST returns 200 with an empty representation. So
 * "refused" here means: zero rows affected AND the row still holds its old
 * value. Checking only the status code would pass a policy that actually works.
 *
 * Every table, every verb (plan §5.2: "`for all` policies are easy to get
 * subtly wrong"). The targets are probe rows the administrator created for
 * this run, so a broken policy damages nothing real.
 */
async function checkUpdateDeleteRefused(label, token, probe) {
  if (probe === null) {
    skip(`${label}: UPDATE/DELETE on every table`, 'no probe rows (admin credentials absent)');
    return;
  }

  const targets = [
    ['app_users', probe.userId, 'display_name', '__rls_probe_TAMPERED__'],
    ['teams', probe.teamId, 'name', '__rls_probe_TAMPERED__'],
    ['user_team_selections', probe.selectionId, 'selection_order', 23],
  ];

  for (const [table, id, column, tampered] of targets) {
    const read = async () => {
      const result = await rest(`/${table}?id=eq.${id}&select=${column}`);
      return Array.isArray(result.body) ? result.body[0]?.[column] : undefined;
    };
    const original = await read();

    const update = await rest(`/${table}?id=eq.${id}`, {
      method: 'PATCH',
      token,
      body: { [column]: tampered },
      prefer: 'return=representation',
    });
    const afterUpdate = await read();
    if (afterUpdate === original && (isRefusal(update) || update.body?.length === 0)) {
      pass(`${label}: UPDATE ${table} refused`, `HTTP ${update.status}, row unchanged`);
    } else {
      fail(
        `${label}: UPDATE ${table}`,
        `ROW WAS MODIFIED — ${column} is now ${JSON.stringify(afterUpdate)}`,
      );
    }

    const del = await rest(`/${table}?id=eq.${id}`, {
      method: 'DELETE',
      token,
      prefer: 'return=representation',
    });
    const stillThere = (await read()) !== undefined;
    if (stillThere && (isRefusal(del) || del.body?.length === 0)) {
      pass(`${label}: DELETE ${table} refused`, `HTTP ${del.status}, row still present`);
    } else {
      fail(`${label}: DELETE ${table}`, 'ROW WAS DELETED');
    }
  }
}

async function checkReorderRpcRefused(label, token, userId, selectionIds) {
  // A real, well-formed call: the board's own ids. Only the caller is wrong.
  const result = await rest('/rpc/reorder_selections', {
    method: 'POST',
    token,
    body: { p_user_id: userId, p_ordered_ids: selectionIds },
  });
  if (isRefusal(result)) {
    pass(
      `${label}: reorder_selections() refused`,
      `HTTP ${result.status} ${result.body?.code ?? ''}`,
    );
  } else {
    fail(
      `${label}: reorder_selections()`,
      `NOT REFUSED — HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 200)}`,
    );
  }
}

async function checkIsAdmin(label, token, expected) {
  const result = await rest('/rpc/is_admin', { method: 'POST', token, body: {} });
  if (result.status === 200 && result.body === expected) {
    pass(`${label}: is_admin() = ${expected}`);
  } else {
    fail(
      `${label}: is_admin()`,
      `expected ${expected}, got HTTP ${result.status} ${JSON.stringify(result.body)}`,
    );
  }
}

/**
 * Plan §5.2: "confirm sign-ups are still disabled in Supabase Auth". Read from
 * the public settings endpoint; no account is created to find out.
 */
async function checkSignupsDisabled() {
  const response = await fetch(`${AUTH}/settings`, { headers: { apikey: ANON_KEY } });
  const body = await response.json().catch(() => null);
  if (response.ok && body?.disable_signup === true) {
    pass('Auth: public sign-ups are disabled', 'disable_signup = true');
  } else if (response.ok && body?.disable_signup === false) {
    fail(
      'Auth: public sign-ups',
      'ENABLED — Authentication → Sign In / Providers → turn off "Allow new users to sign up"',
    );
  } else {
    fail('Auth: public sign-ups', `could not read ${AUTH}/settings (HTTP ${response.status})`);
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log(`\nRLS verification against ${SUPABASE_URL}`);
console.log('Talking to PostgREST directly — the Worker is not involved.\n');

// Seeded ids used as INSERT targets and as a source of truth for reads.
const seedUsers = await rest('/app_users?select=id,display_name,user_team_selections(id)&limit=1');
const seedTeams = await rest('/teams?select=id&limit=1');
const seededUser = Array.isArray(seedUsers.body) ? (seedUsers.body[0] ?? null) : null;
const seededUserId = seededUser?.id ?? null;
const seededSelectionIds = (seededUser?.user_team_selections ?? []).map((row) => row.id);
const seededTeamId = Array.isArray(seedTeams.body) ? (seedTeams.body[0]?.id ?? null) : null;

if (seededUserId === null) {
  console.error('Could not read any app_users as anon. Apply 0001–0003 and seed.sql first.');
  process.exit(2);
}

// ── Admin session, used both to test the positive case and to build a probe row
let adminToken = null;
if (env.VERIFY_ADMIN_EMAIL && env.VERIFY_ADMIN_PASSWORD) {
  const result = await signIn(env.VERIFY_ADMIN_EMAIL, env.VERIFY_ADMIN_PASSWORD);
  adminToken = result.token;
  if (adminToken === null) console.log(`(admin sign-in failed: ${result.error})`);
}

// Probe rows, one per table, created by the administrator for this run and
// removed at the end. The update/delete attacks target these, never real rows.
let probe = null;
if (adminToken !== null) {
  const createOne = async (table, body) => {
    const created = await rest(`/${table}`, {
      method: 'POST',
      token: adminToken,
      body,
      prefer: 'return=representation',
    });
    return Array.isArray(created.body) ? (created.body[0] ?? null) : null;
  };
  const user = await createOne('app_users', { display_name: '__rls_probe__' });
  const team = await createOne('teams', {
    provider: 'espn',
    provider_team_id: '__rls_probe_admin__',
    name: '__rls_probe__',
  });
  const selection =
    user && team
      ? await createOne('user_team_selections', {
          user_id: user.id,
          team_id: team.id,
          selection_order: 1,
        })
      : null;
  if (user && team && selection) {
    probe = { userId: user.id, teamId: team.id, selectionId: selection.id };
  } else {
    console.log('(the probe rows could not all be created; removing the ones that were)');
    if (user) await rest(`/app_users?id=eq.${user.id}`, { method: 'DELETE', token: adminToken });
    if (team) await rest(`/teams?id=eq.${team.id}`, { method: 'DELETE', token: adminToken });
  }
}

// ── 1. anon ──────────────────────────────────────────────────────────────────
section('1. anon — the role every viewer uses (plan §11.1)');
await checkReadsAllowed('anon', null);
await checkAdminsInvisible('anon', null);
await checkIsAdmin('anon', null, false);
await checkInsertsRefused('anon', null, seededUserId, seededTeamId);
await checkUpdateDeleteRefused('anon', null, probe);
await checkReorderRpcRefused('anon', null, seededUserId, seededSelectionIds);

// ── 2. non-admin authenticated ───────────────────────────────────────────────
section('2. authenticated, not in `admins` — a signed-in stranger');
if (env.VERIFY_NONADMIN_EMAIL && env.VERIFY_NONADMIN_PASSWORD) {
  const { token, error } = await signIn(env.VERIFY_NONADMIN_EMAIL, env.VERIFY_NONADMIN_PASSWORD);
  if (token === null) {
    fail('non-admin sign-in', error ?? 'unknown');
  } else {
    await checkReadsAllowed('non-admin', token);
    await checkAdminsInvisible('non-admin', token);
    await checkIsAdmin('non-admin', token, false);
    await checkInsertsRefused('non-admin', token, seededUserId, seededTeamId);
    await checkUpdateDeleteRefused('non-admin', token, probe);
    await checkReorderRpcRefused('non-admin', token, seededUserId, seededSelectionIds);
  }
} else {
  skip('non-admin matrix', 'set VERIFY_NONADMIN_EMAIL / VERIFY_NONADMIN_PASSWORD');
}

// ── 3. admin ─────────────────────────────────────────────────────────────────
section('3. administrator — the positive case');
if (adminToken === null) {
  skip('admin matrix', 'set VERIFY_ADMIN_EMAIL / VERIFY_ADMIN_PASSWORD');
} else {
  await checkReadsAllowed('admin', adminToken);
  await checkIsAdmin('admin', adminToken, true);

  if (probe === null) {
    fail('admin: INSERT', 'the probe rows could not be created — admin writes are broken');
  } else {
    pass('admin: INSERT app_users, teams, user_team_selections', 'probe rows created');

    const updates = [
      ['app_users', probe.userId, { display_name: '__rls_probe_renamed__' }],
      ['teams', probe.teamId, { display_name: '__rls_probe__' }],
      ['user_team_selections', probe.selectionId, { selection_order: 2 }],
    ];
    for (const [table, id, patch] of updates) {
      const result = await rest(`/${table}?id=eq.${id}`, {
        method: 'PATCH',
        token: adminToken,
        body: patch,
        prefer: 'return=representation',
      });
      if (result.status === 200 && result.body?.length === 1) {
        pass(`admin: UPDATE ${table}`);
      } else {
        fail(`admin: UPDATE ${table}`, `HTTP ${result.status} ${JSON.stringify(result.body)}`);
      }
    }

    const reorder = await rest('/rpc/reorder_selections', {
      method: 'POST',
      token: adminToken,
      body: { p_user_id: probe.userId, p_ordered_ids: [probe.selectionId] },
    });
    if (reorder.status >= 200 && reorder.status < 300) {
      pass('admin: reorder_selections()', `HTTP ${reorder.status}`);
    } else {
      fail('admin: reorder_selections()', `HTTP ${reorder.status} ${JSON.stringify(reorder.body)}`);
    }
  }

  // Admins should still not be able to read the admins table through the API —
  // the policy-less table is invisible to everyone, by design.
  await checkAdminsInvisible('admin', adminToken);
}

// ── 4. Auth settings ─────────────────────────────────────────────────────────
section('4. Supabase Auth');
await checkSignupsDisabled();

// ── Cleanup, which is also the admin DELETE check ───────────────────────────
if (probe !== null && adminToken !== null) {
  const removals = [
    ['user_team_selections', probe.selectionId],
    ['teams', probe.teamId],
    ['app_users', probe.userId],
  ];
  for (const [table, id] of removals) {
    const removed = await rest(`/${table}?id=eq.${id}`, {
      method: 'DELETE',
      token: adminToken,
      prefer: 'return=representation',
    });
    if (removed.status === 200 && removed.body?.length === 1) {
      pass(`admin: DELETE ${table} (probe cleaned up)`);
    } else {
      fail('cleanup', `probe row ${id} in ${table} may still exist — delete it by hand`);
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(64)}`);
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  • ${failure}`);
  console.log('\nThe database security model is NOT sound. Do not deploy.');
  process.exit(1);
}
console.log('\nEvery write path is refused by the database itself (§30, §31).');
process.exit(0);
