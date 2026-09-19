import type { Envelope, Season, SeasonMetaResponse } from '@cfb/shared';
import { fresh } from '@cfb/shared';
import { Hono } from 'hono';
import { policyFor } from '../cache/policy';
import type { AppBindings } from '../env';
import { cacheControlFor } from '../http/cache-headers';
import { resolveSeason } from '../season/resolve';
import { servicesFor } from '../services/context';

export const metaRoutes = new Hono<AppBindings>();

/**
 * The resolved season is provider-influenced data, so it travels in an
 * envelope like everything else provider-influenced does (§23).
 *
 * When the provider's calendar decided it, the envelope is that calendar read's
 * own: `cached`, `fresh`, or `stale` with the calendar's real `fetchedAt`.
 * When an override or the date heuristic decided it, nothing was fetched, so
 * it is computed now and `source` says how.
 */
metaRoutes.get('/season', async (c) => {
  const services = servicesFor(c);
  const { season, source, calendar } = await resolveSeason(services);
  const ttlSeconds = policyFor('season_calendar').ttlSeconds;

  const envelope: Envelope<Season> =
    source === 'provider' && calendar !== null
      ? { data: season, freshness: calendar.freshness, error: null }
      : fresh(season, {
          provider: services.provider.name,
          ttlSeconds,
          fetchedAt: new Date(services.now()),
        });

  const body: SeasonMetaResponse = { season: envelope, source };
  c.header('Cache-Control', cacheControlFor(envelope.freshness, services.now()));
  return c.json(body);
});
