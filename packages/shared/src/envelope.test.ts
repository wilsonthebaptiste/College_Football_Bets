import { describe, expect, it } from 'vitest';
import {
  appError,
  cached,
  failed,
  fresh,
  hasData,
  isStale,
  stale,
  unavailable,
  unavailableFreshness,
} from './envelope';

const FETCHED_AT = '2025-10-01T19:42:00.000Z';

describe('envelope constructors', () => {
  it('fresh() marks provider-sourced data and computes the expiry', () => {
    const e = fresh({ rank: 4 }, { provider: 'espn', ttlSeconds: 60, fetchedAt: FETCHED_AT });

    expect(e.data).toEqual({ rank: 4 });
    expect(e.error).toBeNull();
    expect(e.freshness).toEqual({
      state: 'fresh',
      fetchedAt: FETCHED_AT,
      ttlSeconds: 60,
      expiresAt: '2025-10-01T19:43:00.000Z',
      source: 'provider',
      provider: 'espn',
    });
  });

  it('cached() keeps the data but records that it came from the cache', () => {
    const e = cached('x', { provider: 'espn', ttlSeconds: 900, fetchedAt: FETCHED_AT });

    expect(e.freshness.state).toBe('cached');
    expect(e.freshness.source).toBe('cache');
    expect(e.data).toBe('x');
  });

  it('accepts a Date as well as an ISO string', () => {
    const e = fresh(1, { provider: 'mock', ttlSeconds: 30, fetchedAt: new Date(FETCHED_AT) });
    expect(e.freshness.fetchedAt).toBe(FETCHED_AT);
  });

  it('unavailable() has no data, no error, and no timestamp', () => {
    const e = unavailable<string>('espn', 1800);

    expect(e.data).toBeNull();
    expect(e.error).toBeNull();
    expect(e.freshness).toEqual({
      state: 'unavailable',
      fetchedAt: null,
      ttlSeconds: 1800,
      expiresAt: null,
      source: 'none',
      provider: 'espn',
    });
  });

  it('failed() carries the reason so §38 can distinguish failure kinds', () => {
    const e = failed<string>(
      appError('provider_unavailable', 'Sports data temporarily unavailable.', 'req-1'),
      'espn',
    );

    expect(e.data).toBeNull();
    expect(e.freshness.state).toBe('unavailable');
    expect(e.error).toEqual({
      kind: 'provider_unavailable',
      message: 'Sports data temporarily unavailable.',
      requestId: 'req-1',
    });
  });

  it('unavailableFreshness() never invents a fetchedAt', () => {
    expect(unavailableFreshness('mock', 0).fetchedAt).toBeNull();
  });

  it('tolerates an unparseable fetchedAt by declining to compute an expiry', () => {
    const e = fresh(1, { provider: 'espn', ttlSeconds: 60, fetchedAt: 'not-a-date' });
    expect(e.freshness.expiresAt).toBeNull();
  });
});

describe('§39 — stale data must not look current', () => {
  it('stale() preserves the ORIGINAL fetchedAt, not the time of the failed retry', () => {
    const originallyFetchedAt = '2025-10-01T19:00:00.000Z';

    // Simulates: cache hit, TTL expired, revalidation failed. The caller passes
    // the timestamp the cached entry was stored with — never "now".
    const e = stale(
      { rank: 4 },
      { provider: 'espn', ttlSeconds: 60, fetchedAt: originallyFetchedAt },
    );

    expect(e.freshness.state).toBe('stale');
    expect(e.freshness.fetchedAt).toBe(originallyFetchedAt);
    expect(e.data).toEqual({ rank: 4 });
    // Expiry is in the past — which is exactly the point.
    expect(Date.parse(e.freshness.expiresAt ?? '')).toBeLessThan(
      Date.parse('2025-10-01T19:42:00Z'),
    );
  });

  it('isStale() is true only for the stale state', () => {
    const init = { provider: 'espn', ttlSeconds: 60, fetchedAt: FETCHED_AT } as const;

    expect(isStale(stale(1, init))).toBe(true);
    expect(isStale(fresh(1, init))).toBe(false);
    expect(isStale(cached(1, init))).toBe(false);
    expect(isStale(unavailable<number>('espn'))).toBe(false);
  });
});

describe('hasData', () => {
  it('narrows an envelope that holds data', () => {
    const e = fresh({ wins: 4 }, { provider: 'espn', ttlSeconds: 60, fetchedAt: FETCHED_AT });

    if (hasData(e)) {
      // Type-level assertion: `e.data` is non-null inside this branch.
      expect(e.data.wins).toBe(4);
    } else {
      throw new Error('expected data');
    }
  });

  it('is false for both unavailable and failed envelopes', () => {
    expect(hasData(unavailable<number>('espn'))).toBe(false);
    expect(hasData(failed<number>(appError('internal', 'boom'), 'espn'))).toBe(false);
  });
});
