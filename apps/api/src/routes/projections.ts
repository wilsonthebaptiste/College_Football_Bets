import type { BoardProjectionResponse, ProjectionsResponse } from '@cfb/shared';
import { Hono } from 'hono';
import { supabasePublic } from '../db/client';
import { isUuid } from '../db/queries';
import type { AppBindings } from '../env';
import { cacheControlCapped, xCacheValue } from '../http/cache-headers';
import { notFound } from '../http/errors';
import { servicesFor } from '../services/context';
import { getAllProjections, getBoardProjection } from '../services/projection';

/**
 * Projected points (context/predicting_score.md, Phase 3): two public reads,
 * both cheap, both degrading in labelled pieces.
 *
 *   GET /api/projections                   every board's total
 *   GET /api/users/:userId/projection      one board, per-team breakdown
 *
 * ## Why this is not a field on the board response
 *
 * The board is the application's most important read, cached for 60 seconds;
 * the projection's inputs are cached for six hours. Fusing them would either
 * make a board depend on somebody else's web server, or make the projection
 * refresh 360 times more often than its sources change. The team page's
 * schedule is the precedent (§42): a scrape failure must not be able to degrade
 * a board, and a test asserts the board response has no projection field.
 *
 * ## What it is, and what it is not
 *
 * Every probability is quoted from a publisher, the arithmetic is the owner's
 * own rubric, and exactly one quantity — P(a team finishes in the final Top 25)
 * — is modelled by us and labelled as ours in every term that uses it. It is a
 * projection, never a live score and never a result: the response carries each
 * input's own freshness and each publisher's own stamp so a screen can say "as
 * of <their stamp>" rather than our read time (§23, §39, §46).
 *
 * `/api/users/:userId/projection` is mounted here rather than on `userRoutes`
 * so that the whole feature is one file and one mount, and so that nothing in
 * the board's own routes has to know this exists.
 */
export const projectionRoutes = new Hono<AppBindings>();

/**
 * Two minutes, the composite's own TTL (`cache/policy.ts`). Deliberately not
 * derived from the inputs' expiry: they live for six hours, and a response
 * pinned that long would outlast both an admin's board change and a publisher's
 * recompute.
 */
const PROJECTION_MAX_AGE_SECONDS = 120;

projectionRoutes.get('/projections', async (c) => {
  const services = servicesFor(c);
  const { body, cacheStatus } = await getAllProjections(services, supabasePublic(c.env));

  // After the await, never before. A header set on the context is merged into
  // whatever response finally comes out, including the error handler's.
  c.header('Cache-Control', cacheControlCapped(body.freshness, PROJECTION_MAX_AGE_SECONDS));
  c.header('X-Cache', xCacheValue(cacheStatus));
  return c.json(body satisfies ProjectionsResponse);
});

projectionRoutes.get('/users/:userId/projection', async (c) => {
  const userId = c.req.param('userId');
  // Validated before a database client is built: a malformed id is a 404
  // whatever state the database is in, and costs no round trip.
  if (!isUuid(userId)) throw notFound('No such user.');

  const services = servicesFor(c);
  const { body, cacheStatus } = await getBoardProjection(services, supabasePublic(c.env), userId);

  c.header('Cache-Control', cacheControlCapped(body.freshness, PROJECTION_MAX_AGE_SECONDS));
  c.header('X-Cache', xCacheValue(cacheStatus));
  return c.json(body satisfies BoardProjectionResponse);
});
