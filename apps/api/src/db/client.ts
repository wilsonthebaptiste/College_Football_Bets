import type { Env } from '../env';
import { internalError } from '../http/errors';
import { PostgrestClient } from './postgrest';

/**
 * The two secrets are typed as required, but at runtime they are only present if
 * `.dev.vars` (locally) or `wrangler secret put` (deployed) supplied them.
 * Forgetting that file is the most likely first-run mistake, so name it in the
 * log instead of failing later with an opaque TypeError.
 */
function assertConfigured(env: Env): void {
  const missing = (['SUPABASE_URL', 'SUPABASE_ANON_KEY'] as const).filter(
    (key) => typeof env[key] !== 'string' || env[key] === '',
  );
  if (missing.length > 0) {
    throw internalError(
      'The application database is not configured.',
      `Missing ${missing.join(' and ')}. Locally: copy apps/api/.dev.vars.example to apps/api/.dev.vars and restart. Deployed: wrangler secret put.`,
    );
  }
}

/**
 * Exactly two database factories exist. There is no third.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS NO `supabaseAsServiceRole()`
 *
 * The service-role key bypasses Row Level Security entirely. Adding it here
 * would mean every policy in `supabase/migrations/0002_rls.sql` is decorative,
 * and §31 ("security rules must exist outside the UI") would be satisfied only
 * on paper — the Worker would be the real boundary, and a single missing `if`
 * in a route handler would be a full write bypass.
 *
 * This application has no legitimate need for it. There is no user-provisioning
 * job, no background writer, no migration runner in the request path. Reads are
 * public and run as `anon`; writes carry the administrator's own token so the
 * database can see who is asking and decide for itself.
 *
 * If a future task looks like it needs the service-role key, that is a signal
 * the RLS model is being worked around rather than used. Fix the policy.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Reads. Sends the anon key as `apikey` and NO user token, so PostgREST runs the
 * query as the `anon` role, which the read policies grant (plan §11.1 — viewers
 * never sign in).
 */
export function supabasePublic(env: Env): PostgrestClient {
  assertConfigured(env);
  return new PostgrestClient({
    baseUrl: env.SUPABASE_URL,
    apiKey: env.SUPABASE_ANON_KEY,
    accessToken: null,
    role: 'anon',
  });
}

/**
 * Writes. Sends the administrator's own access token, so `auth.uid()` resolves
 * inside Postgres and `is_admin()` can answer honestly.
 *
 * Note the name: "as admin" means *impersonating the caller who claims to be an
 * admin*, not "with elevated privileges". If the caller is not in the `admins`
 * table, this client can read but every write it attempts is refused by the
 * database. That is the intended behaviour, and the Worker's own 403 is merely
 * a nicer error message in front of it.
 */
export function supabaseAsAdmin(env: Env, accessToken: string): PostgrestClient {
  assertConfigured(env);
  return new PostgrestClient({
    baseUrl: env.SUPABASE_URL,
    apiKey: env.SUPABASE_ANON_KEY,
    accessToken,
    role: 'admin',
  });
}
