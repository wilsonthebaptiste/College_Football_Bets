import type { BoardResponse, UserDetailResponse, UsersResponse } from '@cfb/shared';
import { Hono } from 'hono';
import { supabasePublic } from '../db/client';
import { getUserWithSelections, isUuid, listUsers } from '../db/queries';
import type { AppBindings } from '../env';
import { setCacheHeaders } from '../http/cache-headers';
import { notFound } from '../http/errors';
import { getBoard } from '../services/board';
import { servicesFor } from '../services/context';

/**
 * Public read routes (plan §11.1) — no token, no session, no JWKS hop.
 *
 * Everything here is application-owned data: nine display names and their team
 * selections. It changes only when an administrator changes it, so it caches
 * comfortably and never needs a freshness envelope (§45).
 */
export const userRoutes = new Hono<AppBindings>();

const USERS_MAX_AGE_SECONDS = 300;

userRoutes.get('/', async (c) => {
  const users = await listUsers(supabasePublic(c.env));
  const body: UsersResponse = { users };

  c.header('Cache-Control', `public, max-age=${String(USERS_MAX_AGE_SECONDS)}`);
  return c.json(body);
});

userRoutes.get('/:userId', async (c) => {
  const userId = c.req.param('userId');
  // Validate before building a database client: a malformed id is a 404
  // whatever state the database is in, and costs no round trip.
  if (!isUuid(userId)) throw notFound('No such user.');

  const { user, selections } = await getUserWithSelections(supabasePublic(c.env), userId);
  const body: UserDetailResponse = { user, selections };

  c.header('Cache-Control', `public, max-age=${String(USERS_MAX_AGE_SECONDS)}`);
  return c.json(body);
});

/**
 * §13, §27 — the consolidated board: every team's sports data in one response.
 * Always a 200 once the user exists: a team whose data failed is a card with
 * an error, not a failed board (§38, §42).
 */
userRoutes.get('/:userId/board', async (c) => {
  const userId = c.req.param('userId');
  if (!isUuid(userId)) throw notFound('No such user.');

  const services = servicesFor(c);
  const { body, cacheStatus, degraded } = await getBoard(services, supabasePublic(c.env), userId);

  setCacheHeaders(c, body.freshness, cacheStatus, services.now(), degraded);
  return c.json(body satisfies BoardResponse);
});
