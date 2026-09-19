import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../env';
import { HttpError } from '../http/errors';

/**
 * A best-effort read budget per client address (plan §5.3, "open-API abuse
 * budget"; §10 risk register, "public read API scraped or crawled").
 *
 * Reads are public (plan §11.1), so anyone can poll the API as fast as they
 * like, and every miss costs Worker requests, KV reads, and ESPN calls against
 * free-tier budgets. This is the cheap brake: a token bucket per address, in
 * isolate memory.
 *
 * Deliberately imperfect, as the plan says. Each isolate keeps its own buckets,
 * so a client spread across isolates gets more than the limit, and nothing is
 * shared or persisted. It stops one noisy client hammering one isolate, which
 * is the realistic case. The dashboard usage alert (docs/ops.md) is the
 * backstop for everything else.
 *
 * Sized for people, not scripts. A board polls every 15 s while a team is
 * live, and a team page makes three reads. Nine friends watching a game on one
 * Wi-Fi share an address, so the budget is generous: a burst of 120, refilled
 * at 2 a second (120 a minute sustained). `READ_RATE_LIMIT_PER_MINUTE`
 * changes it; `off` turns it off.
 *
 * Admin routes are not limited here: they need a token, and there is one admin.
 */

export const DEFAULT_READS_PER_MINUTE = 120;
/** Enough for every address a busy isolate sees in a few minutes; the oldest are dropped first. */
const MAX_TRACKED_ADDRESSES = 5_000;

interface Bucket {
  tokens: number;
  updatedMs: number;
}

const buckets = new Map<string, Bucket>();

export interface RateVerdict {
  allowed: boolean;
  /** Seconds until one request would be allowed again. 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Takes one token from `key`'s bucket. The bucket holds `perMinute` tokens and
 * refills continuously at `perMinute / 60` a second.
 */
export function takeToken(key: string, now: number, perMinute: number): RateVerdict {
  const refillPerMs = perMinute / 60_000;
  const previous = buckets.get(key);
  const elapsed = previous === undefined ? 0 : Math.max(0, now - previous.updatedMs);
  const available =
    previous === undefined
      ? perMinute
      : Math.min(perMinute, previous.tokens + elapsed * refillPerMs);

  // Re-inserting keeps Map order as "least recently seen first", so eviction
  // drops the address that has been quiet longest.
  buckets.delete(key);
  if (buckets.size >= MAX_TRACKED_ADDRESSES) {
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }

  if (available >= 1) {
    buckets.set(key, { tokens: available - 1, updatedMs: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  buckets.set(key, { tokens: available, updatedMs: now });
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((1 - available) / refillPerMs / 1000)),
  };
}

/** `READ_RATE_LIMIT_PER_MINUTE`: a positive number, or `off`/`0` to disable. Anything else → the default. */
export function readsPerMinute(raw: string | undefined): number | null {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === 'off' || value === '0') return null;
  const parsed = Number(value);
  return value !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_READS_PER_MINUTE;
}

export const readRateLimit = createMiddleware<AppBindings>(async (c, next) => {
  const isRead = c.req.method === 'GET' || c.req.method === 'HEAD';
  if (!isRead || c.req.path.startsWith('/api/admin')) return next();

  const perMinute = readsPerMinute(c.env.READ_RATE_LIMIT_PER_MINUTE);
  // Cloudflare sets this on every request it proxies. Without it (tests, some
  // local setups) there is no address to key on, so there is no limit.
  const address = c.req.header('CF-Connecting-IP');
  if (perMinute === null || address === undefined || address === '') return next();

  const verdict = takeToken(address, Date.now(), perMinute);
  if (!verdict.allowed) {
    c.header('Retry-After', String(verdict.retryAfterSeconds));
    // The address itself is not logged: counting refusals is enough to notice a crawl.
    throw new HttpError(
      'rate_limited',
      'Too many requests. Wait a moment and try again.',
      `read budget exhausted (${String(perMinute)}/min)`,
    );
  }
  return next();
});

/** Test seam: the buckets are module scope. */
export function resetRateLimits(): void {
  buckets.clear();
}
