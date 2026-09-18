import { createMiddleware } from 'hono/factory';
import { getSigningKeys } from '../auth/jwks';
import { JwtError, peekKeyId, verifyJwt, type VerifiedJwt } from '../auth/jwt';
import { supabaseAsAdmin } from '../db/client';
import { callIsAdmin } from '../db/queries';
import { SUPABASE_AUDIENCE, supabaseIssuer, type AppBindings, type Env } from '../env';
import { forbidden, unauthorized } from '../http/errors';

/**
 * Mounted on `/api/admin/*` and nowhere else.
 *
 * Read routes are public (plan §11.1), so keeping this off the public path means
 * a board request never touches JWKS, never parses a token, and never waits on
 * Supabase Auth.
 *
 * Two distinct failures, two distinct statuses — the difference matters both to
 * the client (401 means "log in", 403 means "you are logged in and still not
 * allowed") and to the Phase 5 negative tests:
 *
 *   401 — no token, or a token that does not verify
 *   403 — a perfectly valid token belonging to an account not in `admins`
 *
 * And note what this middleware is NOT: the security boundary. RLS refuses the
 * write regardless (§30, §31). This is a better error message in front of the
 * database's own decision.
 */

function parseBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

async function verifyAccessToken(env: Env, token: string): Promise<VerifiedJwt> {
  const options = {
    issuer: supabaseIssuer(env),
    audience: SUPABASE_AUDIENCE,
  };

  const keys = await getSigningKeys(env);
  try {
    return await verifyJwt(token, { ...options, keys });
  } catch (error) {
    // An unrecognized `kid` most likely means the project rotated its signing
    // key since we cached the set. Worth exactly one forced refresh.
    const rotationPossible =
      error instanceof JwtError && error.reason === 'unknown_key' && peekKeyId(token) !== null;
    if (!rotationPossible) throw error;

    const refreshed = await getSigningKeys(env, { forceRefresh: true });
    return verifyJwt(token, { ...options, keys: refreshed });
  }
}

export const requireAdmin = createMiddleware<AppBindings>(async (c, next) => {
  const token = parseBearer(c.req.header('Authorization'));
  if (token === null) {
    throw unauthorized('Authentication required.');
  }

  let verified: VerifiedJwt;
  try {
    verified = await verifyAccessToken(c.env, token);
  } catch (error) {
    // Deliberately one message for every verification failure. Telling a caller
    // *why* their forged token was rejected is free help for forging a better one.
    throw unauthorized(
      'Invalid or expired session.',
      error instanceof JwtError ? error.reason : 'verification_failed',
    );
  }

  // The database decides who is an administrator, not a claim in the token.
  const isAdmin = await callIsAdmin(supabaseAsAdmin(c.env, token));
  if (!isAdmin) {
    throw forbidden('Administrator access required.', `auth_user_id=${verified.sub}`);
  }

  c.set('admin', { authUserId: verified.sub, accessToken: token });
  await next();
});
