import type {
  AdminSessionResponse,
  CreateUserRequest,
  CreateUserResponse,
  TeamSearchResponse,
} from '@cfb/shared';
import { Hono } from 'hono';
import { supabaseAsAdmin } from '../db/client';
import { createUser } from '../db/queries';
import type { AppBindings } from '../env';
import { invalidRequest } from '../http/errors';
import { requireAdmin } from '../middleware/require-admin';
import { servicesFor } from '../services/context';
import { parseQuery, searchTeams } from '../services/search';

/**
 * `/api/admin/*` — the only authenticated branch of the API.
 *
 * Implemented so far: user creation (Phase 1), team search (Phase 2), and the
 * session check (Phase 3). The rest of §8's admin surface (rename, add/remove
 * selection, reorder) arrives with the admin console in Phase 5. Everything
 * added later inherits the authorization by being mounted here.
 */
export const adminRoutes = new Hono<AppBindings>();

adminRoutes.use('*', requireAdmin);

/**
 * Reaching this handler IS the answer: `requireAdmin` has already returned 401
 * for a missing or bad token and 403 for a valid one that is not in `admins`.
 * The web app's `/admin` route uses it to tell those cases apart.
 */
adminRoutes.get('/session', (c) => {
  const body: AdminSessionResponse = { admin: { authUserId: c.get('admin').authUserId } };
  c.header('Cache-Control', 'private, no-store');
  return c.json(body);
});

const DISPLAY_NAME_MIN = 1;
const DISPLAY_NAME_MAX = 60;

/** Mirrors the CHECK constraint in 0001_schema.sql. The database is the enforcer. */
function parseDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidRequest('displayName must be a string.');
  }
  const trimmed = value.trim();
  if (trimmed.length < DISPLAY_NAME_MIN || trimmed.length > DISPLAY_NAME_MAX) {
    throw invalidRequest(
      `displayName must be between ${String(DISPLAY_NAME_MIN)} and ${String(DISPLAY_NAME_MAX)} characters.`,
    );
  }
  return trimmed;
}

adminRoutes.post('/users', async (c) => {
  const payload = (await c.req.json().catch(() => null)) as CreateUserRequest | null;
  const displayName = parseDisplayName(payload?.displayName);

  // Note the client: the administrator's own token, not an elevated key. If they
  // are somehow not in `admins`, Postgres refuses this insert on its own (§31).
  const db = supabaseAsAdmin(c.env, c.get('admin').accessToken);
  const user = await createUser(db, displayName);

  const body: CreateUserResponse = { user };
  c.header('Cache-Control', 'no-store');
  return c.json(body, 201);
});

/**
 * §43 — candidate team identities for a board. Admin-only because only the
 * administrator picks teams, and so that an open search box is not one more
 * public endpoint to crawl.
 */
adminRoutes.get('/teams/search', async (c) => {
  const query = parseQuery(c.req.query('q'));
  const teams = await searchTeams(servicesFor(c), query);

  const body: TeamSearchResponse = { teams };
  c.header('Cache-Control', 'private, no-store');
  return c.json(body);
});
