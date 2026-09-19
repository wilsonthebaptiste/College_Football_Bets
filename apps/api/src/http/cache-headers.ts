import type { Freshness } from '@cfb/shared';
import type { Context } from 'hono';
import type { CacheStatus } from '../cache/swr';
import type { AppBindings } from '../env';

/**
 * `Cache-Control` and `X-Cache` for provider-backed responses (plan §7, §8).
 *
 * `max-age` is the time left until the data's own expiry, not the category's
 * full TTL, so a browser or edge cache never holds a response past the moment
 * the Worker would have refreshed it. That is also what keeps polling cheap:
 * repeat reads inside the window never reach the Worker (§24, "avoid duplicate
 * requests").
 */

/** Stale data is served because something is failing; let clients retry soon. */
const STALE_MAX_AGE_SECONDS = 10;

export function cacheControlFor(freshness: Freshness, now: number): string {
  if (freshness.state === 'unavailable') return 'no-store';
  if (freshness.state === 'stale') return `public, max-age=${String(STALE_MAX_AGE_SECONDS)}`;

  const expires = freshness.expiresAt === null ? Number.NaN : Date.parse(freshness.expiresAt);
  const remaining = Number.isNaN(expires)
    ? freshness.ttlSeconds
    : Math.floor((expires - now) / 1000);
  const maxAge = Math.max(0, Math.min(remaining, freshness.ttlSeconds));
  return `public, max-age=${String(maxAge)}`;
}

/** The plan's vocabulary is hit | miss | stale; "nothing to serve" reports as a miss. */
export function xCacheValue(status: CacheStatus): 'hit' | 'miss' | 'stale' {
  return status === 'unavailable' ? 'miss' : status;
}

export function setCacheHeaders(
  c: Context<AppBindings>,
  freshness: Freshness,
  status: CacheStatus,
  now: number,
  degraded = false,
): void {
  // A composite can be stale or failing in a part (one card) while its own
  // envelope is fresh. Either way the response gets the short lifetime, so a
  // browser or edge cache does not pin a broken card for a full TTL.
  const control =
    (status === 'stale' || degraded) && freshness.state !== 'unavailable'
      ? `public, max-age=${String(STALE_MAX_AGE_SECONDS)}`
      : cacheControlFor(freshness, now);
  c.header('Cache-Control', control);
  c.header('X-Cache', xCacheValue(status));
}
