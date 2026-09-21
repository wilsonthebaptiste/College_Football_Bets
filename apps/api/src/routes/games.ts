import type { GameResponse, PredictionResponse } from '@cfb/shared';
import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { setCacheHeaders } from '../http/cache-headers';
import { invalidRequest, notFound } from '../http/errors';
import { isProviderId } from '../providers/ids';
import { servicesFor } from '../services/context';
import { getGame, getPrediction } from '../services/games';

/**
 * Public game reads. `:gameId` is the provider's game id: games live only in
 * the cache, never in a table (§45), so there is no id of our own to use.
 *
 * Both ids are checked against a boring shape before anything is fetched. They
 * end up inside provider URLs.
 */
export const gameRoutes = new Hono<AppBindings>();

gameRoutes.get('/:gameId', async (c) => {
  const gameId = c.req.param('gameId');
  if (!isProviderId(gameId)) throw notFound('No such game.');

  // `?team=<providerTeamId>` picks whose side the score is told from.
  const team = c.req.query('team') ?? null;
  if (team !== null && !isProviderId(team)) throw invalidRequest('team is not a valid team id.');

  const services = servicesFor(c);
  const { envelope, cacheStatus } = await getGame(services, gameId, team);

  setCacheHeaders(c, envelope.freshness, cacheStatus, services.now());
  return c.json({ game: envelope } satisfies GameResponse);
});

gameRoutes.get('/:gameId/prediction', async (c) => {
  const gameId = c.req.param('gameId');
  if (!isProviderId(gameId)) throw notFound('No such game.');

  const services = servicesFor(c);
  const { envelope, cacheStatus } = await getPrediction(services, gameId);

  setCacheHeaders(c, envelope.freshness, cacheStatus, services.now());
  return c.json({ prediction: envelope } satisfies PredictionResponse);
});
