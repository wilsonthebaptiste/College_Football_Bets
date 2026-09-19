import type { Context } from 'hono';
import type { EdgeCache, KvStore } from '../cache/tiers';
import { TieredCache } from '../cache/tiers';
import { SwrCache } from '../cache/swr';
import type { AppBindings, Env } from '../env';
import { createProvider } from '../providers/registry';
import type { SportsDataProvider } from '../providers/types';

/**
 * Everything a service needs for one request: the provider, the cache in front
 * of it, and a clock. Built lazily, so routes that never touch sports data
 * (users, admin writes) never construct any of it.
 */
export interface Services {
  env: Env;
  provider: SportsDataProvider;
  cache: SwrCache;
  /** Read at call time, so tests that pin the clock pin everything. */
  now: () => number;
  requestId: string | null;
}

function kvStoreOf(env: Env): KvStore | null {
  const kv = env.SPORTS_KV;
  if (kv === undefined) return null;
  return {
    get: (key) => kv.get(key, 'json'),
    put: (key, value, options) => kv.put(key, value, options),
  };
}

/** `caches.default` in the Workers runtime; absent under Node (tests). */
export function edgeCacheOf(): EdgeCache | null {
  if (typeof caches === 'undefined') return null;
  const edge = caches.default;
  return {
    match: (url) => edge.match(url),
    put: (url, response) => edge.put(url, response),
  };
}

/** `ctx.waitUntil`, when there is an execution context. `app.request()` in tests has none. */
function deferrerOf(c: Context<AppBindings>): ((work: Promise<unknown>) => void) | null {
  try {
    const ctx = c.executionCtx;
    return (work) => ctx.waitUntil(work);
  } catch {
    return null;
  }
}

export interface ServiceOptions {
  requestId: string | null;
  /** Keeps background work (an L2 write) alive past the response, when the runtime allows it. */
  defer: ((work: Promise<unknown>) => void) | null;
}

/**
 * Services outside a request: the cron warmer (`cron/warm.ts`) has an `Env`
 * and an execution context but no Hono `Context`.
 */
export function createServices(env: Env, options: ServiceOptions): Services {
  const now = (): number => Date.now();
  const provider = createProvider(env, now);
  const tiers = new TieredCache({
    kv: kvStoreOf(env),
    edge: edgeCacheOf(),
    now,
    defer: options.defer,
  });
  return {
    env,
    provider,
    cache: new SwrCache({ tiers, provider: provider.name, now, requestId: options.requestId }),
    now,
    requestId: options.requestId,
  };
}

export function servicesFor(c: Context<AppBindings>): Services {
  // Typed as always present; it is not until the first call sets it.
  const existing = c.get('services') as Services | undefined;
  if (existing !== undefined) return existing;

  const services = createServices(c.env, {
    requestId: c.get('requestId') ?? null,
    defer: deferrerOf(c),
  });
  c.set('services', services);
  return services;
}
