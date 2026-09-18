import type { SeasonMetaResponse } from '@cfb/shared';
import { fresh } from '@cfb/shared';
import { Hono } from 'hono';
import { providerName, type AppBindings } from '../env';
import { resolveSeasonForRequest } from '../season/resolve';

export const metaRoutes = new Hono<AppBindings>();

/**
 * The resolved season is provider-influenced data, so it travels in an envelope
 * like everything else provider-influenced does (§23). In Phase 1 it is always
 * computed on the spot and therefore always `fresh`; once Phase 2 caches the
 * provider calendar for six hours, the same route will start returning `cached`
 * and `stale` states without the client needing to change.
 */
const SEASON_TTL_SECONDS = 6 * 60 * 60;

metaRoutes.get('/season', async (c) => {
  const { season, source } = await resolveSeasonForRequest(c.env);

  const body: SeasonMetaResponse = {
    season: fresh(season, {
      provider: providerName(c.env),
      ttlSeconds: SEASON_TTL_SECONDS,
      fetchedAt: new Date(),
    }),
    source,
  };

  c.header('Cache-Control', `public, max-age=${String(SEASON_TTL_SECONDS)}`);
  return c.json(body);
});
