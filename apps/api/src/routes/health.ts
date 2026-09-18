import type { HealthResponse } from '@cfb/shared';
import { Hono } from 'hono';
import { APP_VERSION, providerName, type AppBindings } from '../env';
import { resolveSeasonForRequest } from '../season/resolve';

/**
 * §28 — `GET /api/health`.
 *
 * Deliberately does NOT touch Postgres or the provider. It answers "is the
 * Worker running, and what does it think the world looks like", which is the
 * question you want answered when everything else is failing.
 */
export const healthRoutes = new Hono<AppBindings>();

/**
 * PHASE 1 LIMITATION: this reports whether the Cache API *object exists*, not
 * whether it *works*. On `workers.dev`, `caches.default` exists and silently
 * does nothing, so this returns `true` there too. Do not read it as "L2 is live".
 *
 * Phase 2's `cache/tiers.ts` replaces this with a real probe (write a sentinel,
 * read it back, remember the answer), and this route will report that instead.
 */
function l2Available(): boolean {
  try {
    return typeof caches !== 'undefined' && 'default' in caches;
  } catch {
    return false;
  }
}

healthRoutes.get('/', async (c) => {
  const { season, source } = await resolveSeasonForRequest(c.env);

  const body: HealthResponse = {
    status: 'ok',
    version: APP_VERSION,
    provider: providerName(c.env),
    season,
    seasonSource: source,
    cache: { l2Available: l2Available() },
  };

  // Health must never be cached — it is what you check when you suspect caching.
  c.header('Cache-Control', 'no-store');
  return c.json(body);
});
