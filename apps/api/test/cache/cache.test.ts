import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheCategory, CachePolicy } from '../../src/cache/policy';
import { L3_MIN_TTL_SECONDS, cacheKey, policyFor } from '../../src/cache/policy';
import { SwrCache, resetInflight } from '../../src/cache/swr';
import type { CacheEntry, EdgeCache } from '../../src/cache/tiers';
import {
  TieredCache,
  kvWriteReport,
  peekL1,
  probeL2,
  resetCacheTiers,
} from '../../src/cache/tiers';
import { ProviderError } from '../../src/providers/types';
import { FakeKv } from '../helpers/kv';

const T0 = Date.parse('2026-10-03T18:00:00Z');
let now = T0;
const clock = (): number => now;
const advance = (seconds: number): void => {
  now += seconds * 1000;
};

beforeEach(() => {
  now = T0;
  resetCacheTiers();
  resetInflight();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function kvAdapter(kv: FakeKv) {
  return { get: (key: string) => kv.get(key, 'json'), put: kv.put.bind(kv) };
}

function tiers(kv: FakeKv | null = new FakeKv(), edge: EdgeCache | null = null): TieredCache {
  return new TieredCache({ kv: kv === null ? null : kvAdapter(kv), edge, now: clock, defer: null });
}

function swr(tiered: TieredCache): SwrCache {
  return new SwrCache({ tiers: tiered, provider: 'espn', now: clock, requestId: 'req-1' });
}

function entry<T>(
  value: T,
  policy: CachePolicy,
  kvStoredAtMs: number | null = null,
): CacheEntry<T> {
  return {
    value,
    fetchedAt: new Date(now).toISOString(),
    category: policy.category,
    ttlSeconds: policy.ttlSeconds,
    staleSeconds: policy.staleSeconds,
    provider: 'espn',
    kvStoredAtMs,
  };
}

const down = (): Promise<never> =>
  Promise.reject(new ProviderError('unavailable', 'ESPN is down', { retryable: true }));

// ─── policy.ts ───────────────────────────────────────────────────────────────

describe('policy: one table, and the free tier shapes it (plan §7)', () => {
  const categories: CacheCategory[] = [
    'team_list',
    'season_calendar',
    'rankings',
    'schedule',
    'completed_game',
    'upcoming_game',
    'live_game',
    'prediction',
    'board_composite',
  ];

  it('keeps live games and the board composite out of KV entirely', () => {
    expect(policyFor('live_game').tiers).toEqual(['l1']);
    expect(policyFor('board_composite').tiers).toEqual(['l1']);
  });

  it('never names L3 for a TTL under the 300 s floor', () => {
    for (const category of categories) {
      const policy = policyFor(category);
      if (policy.tiers.includes('l3'))
        expect(policy.ttlSeconds).toBeGreaterThanOrEqual(L3_MIN_TTL_SECONDS);
    }
  });

  it('matches the plan’s TTLs, including the context-dependent ones', () => {
    expect(policyFor('schedule').ttlSeconds).toBe(15 * 60);
    expect(policyFor('live_game').ttlSeconds).toBe(25);
    expect(policyFor('rankings', { seasonType: 'regular' }).ttlSeconds).toBe(60 * 60);
    expect(policyFor('rankings', { seasonType: 'postseason' }).ttlSeconds).toBe(6 * 60 * 60);
    expect(policyFor('board_composite').ttlSeconds).toBe(60);
    expect(policyFor('board_composite', { anyLive: true }).ttlSeconds).toBe(15);
    expect(policyFor('board_composite', { degraded: true }).ttlSeconds).toBe(15);
  });

  it('keys by provider and season, so neither can serve the other’s data', () => {
    expect(cacheKey('schedule', 'espn', '2026:regular', '251')).not.toBe(
      cacheKey('schedule', 'mock', '2026:regular', '251'),
    );
    expect(cacheKey('schedule', 'espn', '2026:regular', '251')).not.toBe(
      cacheKey('schedule', 'espn', '2025:regular', '251'),
    );
  });
});

// ─── tiers.ts ────────────────────────────────────────────────────────────────

describe('tiers: what reaches KV, and how often', () => {
  it('refuses a KV write under 300 s even if a policy asked for L3', async () => {
    const kv = new FakeKv();
    const rogue: CachePolicy = { ...policyFor('live_game'), tiers: ['l1', 'l2', 'l3'] };
    await tiers(kv).put('k', entry(1, rogue), rogue);
    expect(kv.writes).toHaveLength(0);
    expect(peekL1('k')).toBeDefined();
  });

  it('writes a durable category to KV with its stale window as the expiry', async () => {
    const kv = new FakeKv();
    const policy = policyFor('schedule');
    await tiers(kv).put('k', entry({ games: [] }, policy), policy);
    expect(kv.writes).toEqual([{ key: 'k', expirationTtl: 15 * 60 + 6 * 60 * 60 }]);
    expect(kvWriteReport(now).byCategory).toEqual({ schedule: 1 });
  });

  it('writes the same key to KV at most once per write interval', async () => {
    const kv = new FakeKv();
    const cache = swr(tiers(kv));
    const policy = policyFor('schedule');
    let version = 0;
    const read = () =>
      cache.read({ key: 'sched', policyFor: () => policy, load: async () => ++version });

    await read(); // miss → KV write
    advance(16 * 60);
    await read(); // expired → refresh; KV written 16 min ago → skipped
    advance(16 * 60);
    await read();
    expect(version).toBe(3);
    expect(kv.writes).toHaveLength(1);

    advance(30 * 60); // an hour since the KV write
    await read();
    expect(kv.writes).toHaveLength(2);
  });

  it('serves a fresh isolate from KV, promoted into L1', async () => {
    const kv = new FakeKv();
    const policy = policyFor('rankings');
    await tiers(kv).put('k', entry('poll', policy), policy);
    resetCacheTiers(); // a new isolate: empty L1, KV intact

    const hit = await tiers(kv).get<string>('k');
    expect(hit).toMatchObject({ tier: 'l3', entry: { value: 'poll' } });
    expect(peekL1('k')?.value).toBe('poll');
  });

  it('ignores a KV value that is not a cache entry', async () => {
    const kv = new FakeKv();
    await kv.put('k', JSON.stringify({ hello: 'world' }));
    expect(await tiers(kv).get('k')).toBeNull();
  });

  it('stops writing to KV at the daily hard cap, and counts what it refused', async () => {
    const kv = new FakeKv();
    const policy = policyFor('completed_game');
    const tiered = tiers(kv);
    for (let index = 0; index < 905; index += 1) {
      await tiered.put(`game-${String(index)}`, entry(index, policy), policy);
    }
    const report = kvWriteReport(now);
    expect(report.total).toBe(900);
    expect(report.refused).toBe(5);
    expect(kv.writes).toHaveLength(900);
  });

  it('probes L2 for real: an inert Cache API (workers.dev) reports unavailable', async () => {
    const inert: EdgeCache = { match: async () => undefined, put: async () => undefined };
    await expect(probeL2(inert)).resolves.toBe(false);
  });

  it('uses a working Cache API as a middle tier', async () => {
    const store = new Map<string, string>();
    const edge: EdgeCache = {
      match: async (url) => (store.has(url) ? new Response(store.get(url)) : undefined),
      put: async (url, response) => {
        store.set(url, await response.text());
      },
    };
    expect(await probeL2(edge)).toBe(true);

    const policy = policyFor('schedule');
    await tiers(null, edge).put('k', entry('from-edge', policy), policy);
    resetCacheTiers();
    expect(await probeL2(edge)).toBe(true);
    expect(await tiers(null, edge).get('k')).toMatchObject({
      tier: 'l2',
      entry: { value: 'from-edge' },
    });
  });
});

// ─── swr.ts ──────────────────────────────────────────────────────────────────

describe('swr: the §39 state machine', () => {
  const policy = policyFor('schedule');

  it('miss → fresh, then hit → cached, with the same fetchedAt', async () => {
    const cache = swr(tiers());
    const first = await cache.read({ key: 'k', policyFor: () => policy, load: async () => 'v1' });
    expect(first.status).toBe('miss');
    expect(first.envelope.freshness).toMatchObject({ state: 'fresh', source: 'provider' });

    advance(60);
    const second = await cache.read({ key: 'k', policyFor: () => policy, load: async () => 'v2' });
    expect(second.status).toBe('hit');
    expect(second.envelope.data).toBe('v1');
    expect(second.envelope.freshness.state).toBe('cached');
    expect(second.envelope.freshness.fetchedAt).toBe(first.envelope.freshness.fetchedAt);
  });

  it('provider down + expired copy → stale, with the ORIGINAL fetchedAt', async () => {
    const cache = swr(tiers());
    const first = await cache.read({ key: 'k', policyFor: () => policy, load: async () => 'v1' });
    const original = first.envelope.freshness.fetchedAt;

    advance(2 * 60 * 60); // well past the 15-minute TTL, inside the 6-hour stale window
    const second = await cache.read({ key: 'k', policyFor: () => policy, load: down });
    expect(second.status).toBe('stale');
    expect(second.envelope.data).toBe('v1');
    expect(second.envelope.error).toBeNull();
    expect(second.envelope.freshness).toMatchObject({
      state: 'stale',
      source: 'cache',
      fetchedAt: original,
    });
  });

  it('a failed refresh does not refresh the stored timestamp either', async () => {
    const cache = swr(tiers());
    const first = await cache.read({ key: 'k', policyFor: () => policy, load: async () => 'v1' });
    advance(60 * 60);
    await cache.read({ key: 'k', policyFor: () => policy, load: down });
    advance(60 * 60);
    const third = await cache.read({ key: 'k', policyFor: () => policy, load: down });
    expect(third.envelope.freshness.fetchedAt).toBe(first.envelope.freshness.fetchedAt);
  });

  it('provider down + nothing cached → unavailable, with the reason (§38)', async () => {
    const cache = swr(tiers());
    const read = await cache.read({ key: 'k', policyFor: () => policy, load: down });
    expect(read.status).toBe('unavailable');
    expect(read.envelope.data).toBeNull();
    expect(read.envelope.freshness).toMatchObject({
      state: 'unavailable',
      fetchedAt: null,
      source: 'none',
    });
    expect(read.envelope.error).toEqual({
      kind: 'provider_unavailable',
      message: 'Sports data temporarily unavailable.',
      requestId: 'req-1',
    });
  });

  it('past the stale window, old data is discarded, not served', async () => {
    const cache = swr(tiers());
    await cache.read({ key: 'k', policyFor: () => policy, load: async () => 'v1' });
    advance(7 * 60 * 60); // 15 min TTL + 6 h stale window, exceeded
    const read = await cache.read({ key: 'k', policyFor: () => policy, load: down });
    expect(read.status).toBe('unavailable');
  });

  it('distinguishes an invalid payload from an outage', async () => {
    const cache = swr(tiers());
    const read = await cache.read({
      key: 'k',
      policyFor: () => policy,
      load: () => Promise.reject(new ProviderError('invalid_response', 'shape changed')),
    });
    expect(read.envelope.error?.kind).toBe('provider_invalid_response');
  });

  it('coalesces concurrent loads of one key into one provider call', async () => {
    const cache = swr(tiers());
    let calls = 0;
    let release: (value: string) => void = () => undefined;
    const load = (): Promise<string> => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const reads = Array.from({ length: 6 }, () =>
      cache.read({ key: 'shared', policyFor: () => policy, load }),
    );
    // The load starts only after the (async) tier lookup; hold it open until then.
    await vi.waitFor(() => {
      expect(calls).toBe(1);
    });
    release('once');
    const results = await Promise.all(reads);
    expect(calls).toBe(1);
    expect(new Set(results.map((result) => result.envelope.freshness.fetchedAt)).size).toBe(1);
  });

  it('lets fatal errors through instead of serving stale', async () => {
    const cache = swr(tiers());
    await cache.read({ key: 'k', policyFor: () => policy, load: async () => 'v1' });
    advance(60 * 60);
    const gone = new ProviderError('not_found', 'no such game');
    await expect(
      cache.read({
        key: 'k',
        policyFor: () => policy,
        load: () => Promise.reject(gone),
        isFatal: (error) => error === gone,
      }),
    ).rejects.toBe(gone);
  });

  it('can rethrow instead of answering unavailable, for values that are the whole response', async () => {
    const cache = swr(tiers());
    const boom = new Error('database down');
    await expect(
      cache.read({
        key: 'k',
        policyFor: () => policy,
        load: () => Promise.reject(boom),
        whenUnavailable: 'throw',
      }),
    ).rejects.toBe(boom);
  });

  it('chooses the policy from the loaded value (a game’s TTL depends on its status)', async () => {
    const kv = new FakeKv();
    const cache = swr(tiers(kv));
    const read = await cache.read({
      key: 'game',
      policyFor: (status: string) => policyFor(status === 'live' ? 'live_game' : 'completed_game'),
      load: async () => 'live',
    });
    expect(read.envelope.freshness.ttlSeconds).toBe(25);
    expect(kv.writes).toHaveLength(0);
  });
});
