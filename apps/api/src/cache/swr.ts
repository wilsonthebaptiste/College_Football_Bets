import type { AppErrorKind, Envelope, ProviderName } from '@cfb/shared';
import { appError, cached, failed, fresh, stale } from '@cfb/shared';
import { ProviderError, appErrorKindFor } from '../providers/types';
import type { CachePolicy } from './policy';
import type { CacheEntry, TieredCache } from './tiers';
import { isFresh, isServable } from './tiers';

/**
 * The read-through state machine (plan §7, §39):
 *
 *   hit, inside TTL           → the cached value, state `cached`
 *   miss, or past TTL         → ask the provider
 *     provider answers        → the new value, state `fresh`, written back
 *     provider fails + stale  → the old value, state `stale`, ORIGINAL fetchedAt
 *     provider fails, nothing → no value, state `unavailable`, with the reason
 *
 * The hard rule: a failed refresh never touches `fetchedAt`. That timestamp is
 * the user's only defence against believing old data is current, so the stale
 * branch rebuilds the envelope from the stored entry and nothing else.
 */

/** What `X-Cache` reports, plus `unavailable` for "nothing to serve". */
export type CacheStatus = 'hit' | 'miss' | 'stale' | 'unavailable';

export interface CacheRead<T> {
  envelope: Envelope<T>;
  status: CacheStatus;
}

export interface ReadThroughOptions<T> {
  key: string;
  /**
   * The policy for a value just loaded. A function because some TTLs depend on
   * the value itself: a game is cached for a week once final, 25 s while live.
   */
  policyFor: (value: T) => CachePolicy;
  load: () => Promise<T>;
  /**
   * Failures that must propagate instead of degrading to stale/unavailable,
   * such as "no such game": serving an old copy of something that does not
   * exist would be wrong, and the route answers 404.
   */
  isFatal?: (error: unknown) => boolean;
  /**
   * With nothing cached to fall back on: `envelope` (default) answers with an
   * `unavailable` envelope, which is right for one section among many (§42);
   * `throw` rethrows the original error, which is right when the value IS the
   * response and the route has nothing else to show.
   */
  whenUnavailable?: 'envelope' | 'throw';
}

/**
 * In-flight loads, shared across every request this isolate is serving, so six
 * boards asking for the same team at once cause one provider call (plan §2.3).
 * Waiters share the resulting ENTRY, so they all report the same fetchedAt.
 */
const inflight = new Map<string, Promise<CacheEntry<unknown>>>();

const USER_MESSAGES: Record<AppErrorKind, string> = {
  provider_unavailable: 'Sports data temporarily unavailable.',
  provider_invalid_response: 'Sports data could not be read.',
  not_found: 'Not found.',
  invalid_request: 'The request could not be processed.',
  unauthorized: 'Authentication required.',
  forbidden: 'Not permitted.',
  conflict: 'The request conflicts with saved data.',
  rate_limited: 'Too many requests.',
  internal: 'Something went wrong.',
};

function kindOf(error: unknown): AppErrorKind {
  return error instanceof ProviderError ? appErrorKindFor(error) : 'internal';
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export interface SwrDeps {
  tiers: TieredCache;
  provider: ProviderName;
  now: () => number;
  requestId: string | null;
}

export class SwrCache {
  private readonly deps: SwrDeps;

  constructor(deps: SwrDeps) {
    this.deps = deps;
  }

  get provider(): ProviderName {
    return this.deps.provider;
  }

  async read<T>(options: ReadThroughOptions<T>): Promise<CacheRead<T>> {
    const { provider, now } = this.deps;
    const found = await this.deps.tiers.get<T>(options.key);

    if (found !== null && isFresh(found.entry, now())) {
      const { entry } = found;
      return {
        envelope: cached(entry.value, {
          provider,
          ttlSeconds: entry.ttlSeconds,
          fetchedAt: entry.fetchedAt,
        }),
        status: 'hit',
      };
    }

    // Reading L2 and KV takes a few milliseconds. If another request in this
    // isolate refreshed the key meanwhile, use its copy rather than load (and
    // write KV) a second time. In-flight coalescing only covers loads that
    // overlap; this covers the one that finished while this read was waiting.
    // Found in workerd: three cold reads of the season calendar made three KV
    // writes.
    const settled = this.deps.tiers.freshInL1<T>(options.key);
    if (settled !== null) {
      return {
        envelope: cached(settled.value, {
          provider,
          ttlSeconds: settled.ttlSeconds,
          fetchedAt: settled.fetchedAt,
        }),
        status: 'hit',
      };
    }

    try {
      const entry = await this.load(options, found?.entry ?? null);
      return {
        envelope: fresh(entry.value, {
          provider,
          ttlSeconds: entry.ttlSeconds,
          fetchedAt: entry.fetchedAt,
        }),
        status: 'miss',
      };
    } catch (error) {
      if (options.isFatal?.(error) === true) throw error;
      this.log(options.key, error, found !== null);

      if (found !== null && isServable(found.entry, now())) {
        const { entry } = found;
        return {
          // §39: the ORIGINAL fetchedAt, straight from the stored entry.
          envelope: stale(entry.value, {
            provider,
            ttlSeconds: entry.ttlSeconds,
            fetchedAt: entry.fetchedAt,
          }),
          status: 'stale',
        };
      }

      if (options.whenUnavailable === 'throw') throw error;
      const kind = kindOf(error);
      return {
        envelope: failed<T>(appError(kind, USER_MESSAGES[kind], this.deps.requestId), provider),
        status: 'unavailable',
      };
    }
  }

  /**
   * Returns a still-servable entry from any tier without ever calling the
   * provider. For `/api/health`, which must stay provider-free.
   */
  async peek<T>(key: string): Promise<CacheEntry<T> | null> {
    const found = await this.deps.tiers.get<T>(key);
    return found?.entry ?? null;
  }

  private async load<T>(
    options: ReadThroughOptions<T>,
    previous: CacheEntry<T> | null,
  ): Promise<CacheEntry<T>> {
    const pending = inflight.get(options.key);
    if (pending !== undefined) return (await pending) as CacheEntry<T>;

    const work = (async (): Promise<CacheEntry<T>> => {
      const value = await options.load();
      const policy = options.policyFor(value);
      const entry: CacheEntry<T> = {
        value,
        fetchedAt: new Date(this.deps.now()).toISOString(),
        category: policy.category,
        ttlSeconds: policy.ttlSeconds,
        staleSeconds: policy.staleSeconds,
        provider: this.deps.provider,
        // Carried forward so the KV write interval survives the refresh.
        kvStoredAtMs: previous?.kvStoredAtMs ?? null,
      };
      await this.deps.tiers.put(options.key, entry, policy);
      return entry;
    })();

    inflight.set(options.key, work);
    try {
      return await work;
    } finally {
      inflight.delete(options.key);
    }
  }

  private log(key: string, error: unknown, hadCopy: boolean): void {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: hadCopy
          ? 'cache_refresh_failed_serving_stale'
          : 'cache_refresh_failed_nothing_cached',
        requestId: this.deps.requestId,
        key,
        kind: kindOf(error),
        detail: describe(error),
      }),
    );
  }
}

/** Test seam: the in-flight map is module scope. */
export function resetInflight(): void {
  inflight.clear();
}
