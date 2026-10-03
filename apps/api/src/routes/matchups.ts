import type { Freshness, MatchupBoardResponse, MatchupResponse } from '@cfb/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { supabasePublic } from '../db/client';
import type { AppBindings } from '../env';
import { cacheControlFor, xCacheValue } from '../http/cache-headers';
import { invalidRequest, notFound } from '../http/errors';
import { isProviderId } from '../providers/ids';
import { servicesFor } from '../services/context';
import { getMatchup, getMatchupBoard } from '../services/matchups';
import type { CacheStatus } from '../cache/swr';

/**
 * The matchup board (context/plan-matchup-board.md, Phase 1): two public
 * reads, no token, nothing stored.
 *
 *   GET /api/matchups?week=<n>     every game in a week between two boards
 *   GET /api/matchups/:gameId      one game, in the same row shape, for any game
 *
 * `week` is the provider's own week number, as the calendar lists it; leave it
 * out for the current week. `:gameId` is the provider's game id, exactly as
 * `/api/games/:gameId` takes it.
 */
export const matchupRoutes = new Hono<AppBindings>();

/** The shortest lifetime a degraded answer gets everywhere else (`http/cache-headers.ts`). */
const DEGRADED_MAX_AGE_SECONDS = 10;

/**
 * `Cache-Control` from the answer's own expiry: the composite's remaining
 * time, `max-age=10` when anything in it is stale or failing, and `no-store`
 * when there is nothing to show at all.
 */
function setHeaders(
  c: Context<AppBindings>,
  shown: Freshness,
  composite: Freshness | null,
  status: CacheStatus,
  degraded: boolean,
  now: number,
): void {
  const control =
    shown.state === 'unavailable'
      ? 'no-store'
      : degraded || status === 'stale'
        ? `public, max-age=${String(DEGRADED_MAX_AGE_SECONDS)}`
        : cacheControlFor(composite ?? shown, now);
  c.header('Cache-Control', control);
  c.header('X-Cache', xCacheValue(status));
}

/** `?week=` is a small whole number or absent. Anything else is a 400 before any read. */
function parseWeek(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  if (!/^\d{1,3}$/.test(raw)) throw invalidRequest('week must be a week number.');
  return Number(raw);
}

matchupRoutes.get('/', async (c) => {
  const week = parseWeek(c.req.query('week'));
  const services = servicesFor(c);
  const { body, cacheStatus, degraded, composite } = await getMatchupBoard(
    services,
    supabasePublic(c.env),
    week,
  );

  // After the await, never before: a header set on the context is merged into
  // whatever response finally comes out, including the error handler's.
  setHeaders(c, body.freshness, composite, cacheStatus, degraded, services.now());
  return c.json(body satisfies MatchupBoardResponse);
});

matchupRoutes.get('/:gameId', async (c) => {
  const gameId = c.req.param('gameId');
  if (!isProviderId(gameId)) throw notFound('No such game.');

  const services = servicesFor(c);
  const { body, cacheStatus, degraded, composite } = await getMatchup(
    services,
    supabasePublic(c.env),
    gameId,
  );

  setHeaders(c, body.matchup.freshness, composite, cacheStatus, degraded, services.now());
  return c.json(body satisfies MatchupResponse);
});
