import type { HealthResponse } from '@cfb/shared';
import { Hono } from 'hono';
import { kvWriteReport, probeL2 } from '../cache/tiers';
import { APP_VERSION, type AppBindings } from '../env';
import { resolveSeason } from '../season/resolve';
import { edgeCacheOf, servicesFor } from '../services/context';

/**
 * §28 — `GET /api/health`.
 *
 * Deliberately does NOT touch Postgres or the provider. It answers "is the
 * Worker running, and what does it think the world looks like", which is the
 * question you want answered when everything else is failing. The season comes
 * from the cached calendar if one is already cached (`peek`), else from the
 * date heuristic, and `seasonSource` says which.
 */
export const healthRoutes = new Hono<AppBindings>();

healthRoutes.get('/', async (c) => {
  const services = servicesFor(c);
  const [{ season, source }, l2Available] = await Promise.all([
    resolveSeason(services, { peek: true }),
    probeL2(edgeCacheOf()),
  ]);

  const body: HealthResponse = {
    status: 'ok',
    version: APP_VERSION,
    provider: services.provider.name,
    season,
    seasonSource: source,
    cache: { l2Available, kvWrites: kvWriteReport(services.now()) },
  };

  // Health must never be cached — it is what you check when you suspect caching.
  c.header('Cache-Control', 'no-store');
  return c.json(body);
});
