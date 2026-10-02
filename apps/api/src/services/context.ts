import type { Context } from 'hono';
import type { EdgeCache, KvStore } from '../cache/tiers';
import { TieredCache } from '../cache/tiers';
import { SwrCache } from '../cache/swr';
import type { AppBindings, Env } from '../env';
import { createConferenceOddsProvider, createProvider } from '../providers/registry';
import type { ConferenceOddsProvider, SportsDataProvider } from '../providers/types';

/**
 * Everything a service needs for one request: the provider, the cache in front
 * of it, and a clock. Built lazily, so routes that never touch sports data
 * (users, admin writes) never construct any of it.
 */
export interface Services {
  env: Env;
  provider: SportsDataProvider;
  cache: SwrCache;
  /**
   * The conference odds publisher (projected points). Separate from `provider`
   * because it is a separate publisher with a separate failure mode.
   */
  oddsProvider: ConferenceOddsProvider;
  /**
   * The same tiered cache, labelling what it stores with the ODDS publisher's
   * name rather than the sports provider's.
   *
   * Two `SwrCache` instances over one `TieredCache`, because a `SwrCache`
   * carries the provider name it stamps on every envelope it builds. One
   * instance would have dated playoffstatus's figures `espn`, which is the
   * §46 labelling mistake moved into the freshness envelope. The tiers, the
   * key space, and the KV ledger are shared, so this costs nothing.
   */
  oddsCache: SwrCache;
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
  const oddsProvider = createConferenceOddsProvider(env);
  const tiers = new TieredCache({
    kv: kvStoreOf(env),
    edge: edgeCacheOf(),
    now,
    defer: options.defer,
  });
  const swr = (name: SwrCache['provider']): SwrCache =>
    new SwrCache({ tiers, provider: name, now, requestId: options.requestId });
  return {
    env,
    provider,
    cache: swr(provider.name),
    oddsProvider,
    oddsCache: swr(oddsProvider.name),
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
