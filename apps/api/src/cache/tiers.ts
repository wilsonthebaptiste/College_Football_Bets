import type { KvWriteReport, ProviderName } from '@cfb/shared';
import type { CacheCategory, CachePolicy, CacheTier } from './policy';
import { L3_MIN_TTL_SECONDS } from './policy';

/**
 * Three cache tiers, because the free tier forces it (plan §7).
 *
 *   L1  isolate memory     free, instant, gone when the isolate is recycled
 *   L2  Cache API          per data centre; INERT on workers.dev, so optional
 *   L3  Workers KV         global and durable; ~1,000 writes/day, so rationed
 *
 * Reads fall through L1 → L2 → L3. Writes go to every tier the policy names,
 * except that L3 refuses anything with a TTL under 300 s, anything written
 * more recently than the policy's write interval, and everything once the
 * daily cap is reached.
 */

export interface CacheEntry<T> {
  value: T;
  /**
   * When the PROVIDER produced this value. ISO 8601 UTC. A failed refresh never
   * touches it (§39): it is the user's only evidence of how old the data is.
   */
  fetchedAt: string;
  category: CacheCategory;
  ttlSeconds: number;
  staleSeconds: number;
  provider: ProviderName;
  /** When this key was last written to KV (epoch ms), if known. Rations L3 writes. */
  kvStoredAtMs: number | null;
}

export interface TierHit<T> {
  entry: CacheEntry<T>;
  tier: CacheTier;
}

/** The two KV calls this module makes. `env.SPORTS_KV` is adapted to it in `services/context.ts`. */
export interface KvStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
}

/** The two Cache API calls this module makes. */
export interface EdgeCache {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

export interface TierDeps {
  kv: KvStore | null;
  edge: EdgeCache | null;
  now: () => number;
  /** `ctx.waitUntil`, when running in a real request. Slow writes go here. */
  defer: ((work: Promise<unknown>) => void) | null;
}

// ─── Entry timing ────────────────────────────────────────────────────────────

function fetchedAtMs(entry: CacheEntry<unknown>): number {
  return Date.parse(entry.fetchedAt);
}

/** Inside the TTL: serve without asking the provider. */
export function isFresh(entry: CacheEntry<unknown>, now: number): boolean {
  return now < fetchedAtMs(entry) + entry.ttlSeconds * 1000;
}

/** Inside TTL + stale window: may be served as `stale` if a refresh fails. */
export function isServable(entry: CacheEntry<unknown>, now: number): boolean {
  return now < fetchedAtMs(entry) + (entry.ttlSeconds + entry.staleSeconds) * 1000;
}

/** L2 and L3 hand back untyped JSON. Check it is an entry before trusting it. */
function isCacheEntry(value: unknown): value is CacheEntry<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    'value' in entry &&
    typeof entry['fetchedAt'] === 'string' &&
    !Number.isNaN(Date.parse(entry['fetchedAt'])) &&
    typeof entry['category'] === 'string' &&
    typeof entry['ttlSeconds'] === 'number' &&
    typeof entry['staleSeconds'] === 'number' &&
    (entry['provider'] === 'espn' || entry['provider'] === 'mock')
  );
}

// ─── L1: isolate memory ──────────────────────────────────────────────────────

/**
 * Bounded, so a long-lived isolate cannot grow without limit. Map iteration
 * order is insertion order, and `set` re-inserts on every write, so evicting
 * the first key evicts the least recently written.
 */
const L1_MAX_ENTRIES = 1_000;
const l1 = new Map<string, CacheEntry<unknown>>();

function l1Set(key: string, entry: CacheEntry<unknown>): void {
  l1.delete(key);
  l1.set(key, entry);
  if (l1.size > L1_MAX_ENTRIES) {
    const oldest = l1.keys().next().value;
    if (oldest !== undefined) l1.delete(oldest);
  }
}

// ─── L2: Cache API, behind a probe ───────────────────────────────────────────

/** Cache API keys must be URLs. This host is never contacted. */
const L2_ORIGIN = 'https://cfb-cache.internal/';
const l2Url = (key: string): string => `${L2_ORIGIN}${encodeURIComponent(key)}`;

let l2Probe: Promise<boolean> | null = null;

/**
 * Write a sentinel, read it back, and remember the answer for the life of the
 * isolate. On workers.dev, `caches.default` exists and silently stores nothing,
 * so asking whether the object exists (the Phase 1 check) says nothing about
 * whether it works. This does.
 */
export function probeL2(edge: EdgeCache | null): Promise<boolean> {
  if (edge === null) return Promise.resolve(false);
  l2Probe ??= (async () => {
    try {
      const url = `${L2_ORIGIN}__probe`;
      await edge.put(url, new Response('ok', { headers: { 'Cache-Control': 'max-age=60' } }));
      const hit = await edge.match(url);
      return hit !== undefined && (await hit.text()) === 'ok';
    } catch {
      return false;
    }
  })();
  return l2Probe;
}

// ─── L3: KV write accounting ─────────────────────────────────────────────────

/** Warn here; refuse at the hard cap. Both are per isolate (see `KvWriteReport`). */
const KV_SOFT_CAP = 700;
const KV_HARD_CAP = 900;

interface KvLedger {
  day: string;
  total: number;
  byCategory: Map<CacheCategory, number>;
  refused: number;
  warned: boolean;
}

let ledger: KvLedger = newLedger('');

function newLedger(day: string): KvLedger {
  return { day, total: 0, byCategory: new Map(), refused: 0, warned: false };
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function ledgerFor(now: number): KvLedger {
  const day = utcDay(now);
  if (ledger.day !== day) ledger = newLedger(day);
  return ledger;
}

export function kvWriteReport(now: number): KvWriteReport {
  const current = ledgerFor(now);
  return {
    day: current.day,
    total: current.total,
    byCategory: Object.fromEntries(current.byCategory),
    refused: current.refused,
  };
}

// ─── The tiered cache ────────────────────────────────────────────────────────

export class TieredCache {
  private readonly deps: TierDeps;

  constructor(deps: TierDeps) {
    this.deps = deps;
  }

  /** The first tier holding a still-servable entry, promoted into the faster tiers. */
  async get<T>(key: string): Promise<TierHit<T> | null> {
    const now = this.deps.now();

    const memo = l1.get(key);
    if (memo !== undefined) {
      if (isServable(memo, now)) return { entry: memo as CacheEntry<T>, tier: 'l1' };
      l1.delete(key);
    }

    if (await probeL2(this.deps.edge)) {
      const fromEdge = await this.readEdge(key);
      if (fromEdge !== null && isServable(fromEdge, now)) {
        l1Set(key, fromEdge);
        return { entry: fromEdge as CacheEntry<T>, tier: 'l2' };
      }
    }

    if (this.deps.kv !== null) {
      const stored = await this.deps.kv.get(key).catch(() => null);
      if (isCacheEntry(stored) && isServable(stored, now)) {
        l1Set(key, stored);
        return { entry: stored as CacheEntry<T>, tier: 'l3' };
      }
    }

    return null;
  }

  /**
   * L1 only, synchronously, and only while inside its TTL. For the moment just
   * before a load: another request may have refreshed the key while this one
   * was waiting on the slower tiers (see `SwrCache.read`).
   */
  freshInL1<T>(key: string): CacheEntry<T> | null {
    const memo = l1.get(key);
    return memo !== undefined && isFresh(memo, this.deps.now()) ? (memo as CacheEntry<T>) : null;
  }

  /**
   * Writes `entry` to every tier `policy` allows. L1 synchronously; L2 and L3
   * deferred to `waitUntil` when there is one, so a response never waits on KV.
   */
  async put<T>(key: string, entry: CacheEntry<T>, policy: CachePolicy): Promise<void> {
    const now = this.deps.now();
    const toWrite: CacheEntry<T> = { ...entry };
    const slow: Promise<unknown>[] = [];

    if (
      policy.tiers.includes('l3') &&
      this.deps.kv !== null &&
      this.shouldWriteKv(toWrite, policy, now)
    ) {
      toWrite.kvStoredAtMs = now;
      slow.push(this.writeKv(key, toWrite, policy, now));
    }

    if (policy.tiers.includes('l1')) l1Set(key, toWrite);

    if (policy.tiers.includes('l2')) {
      slow.push(this.writeEdge(key, toWrite, policy));
    }

    if (slow.length === 0) return;
    const all = Promise.allSettled(slow);
    if (this.deps.defer !== null) this.deps.defer(all);
    else await all;
  }

  private shouldWriteKv(entry: CacheEntry<unknown>, policy: CachePolicy, now: number): boolean {
    // The plan §7 floor. Belt and braces: the policy table already keeps
    // `live_game` and `board_composite` out of L3, and this makes it impossible
    // for a future row to put a 25-second value into KV by mistake.
    if (policy.ttlSeconds < L3_MIN_TTL_SECONDS) return false;

    const last = entry.kvStoredAtMs;
    if (last !== null && now - last < policy.kvWriteIntervalSeconds * 1000) return false;

    const current = ledgerFor(now);
    if (current.total >= KV_HARD_CAP) {
      current.refused += 1;
      return false;
    }
    return true;
  }

  private async writeKv(
    key: string,
    entry: CacheEntry<unknown>,
    policy: CachePolicy,
    now: number,
  ): Promise<void> {
    const kv = this.deps.kv;
    if (kv === null) return;
    const current = ledgerFor(now);
    current.total += 1;
    current.byCategory.set(policy.category, (current.byCategory.get(policy.category) ?? 0) + 1);
    if (current.total >= KV_SOFT_CAP && !current.warned) {
      current.warned = true;
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'kv_write_soft_cap',
          message: `This isolate has made ${String(current.total)} KV writes today (soft cap ${String(KV_SOFT_CAP)}). Check the KV dashboard.`,
          byCategory: Object.fromEntries(current.byCategory),
        }),
      );
    }
    // KV's minimum expirationTtl is 60 s. Keep the entry through its stale
    // window: that copy is what a fresh isolate serves when ESPN is down.
    const expirationTtl = Math.max(60, policy.ttlSeconds + policy.staleSeconds);
    await kv.put(key, JSON.stringify(entry), { expirationTtl });
  }

  private async readEdge(key: string): Promise<CacheEntry<unknown> | null> {
    const edge = this.deps.edge;
    if (edge === null) return null;
    try {
      const hit = await edge.match(l2Url(key));
      if (hit === undefined) return null;
      const parsed: unknown = await hit.json();
      return isCacheEntry(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeEdge(
    key: string,
    entry: CacheEntry<unknown>,
    policy: CachePolicy,
  ): Promise<void> {
    const edge = this.deps.edge;
    if (edge === null || !(await probeL2(edge))) return;
    const maxAge = policy.ttlSeconds + policy.staleSeconds;
    await edge.put(
      l2Url(key),
      new Response(JSON.stringify(entry), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${String(maxAge)}`,
        },
      }),
    );
  }
}

/**
 * Drops one key from this isolate's L1. For entries that are L1-only and that
 * an admin write has just made wrong: the board composite (plan §5.1). Other
 * isolates keep their copy until it expires, at most the board's 60 s TTL.
 */
export function evictL1(key: string): void {
  l1.delete(key);
}

/** Test seam: L1, the L2 probe, and the KV ledger are all module scope. */
export function resetCacheTiers(): void {
  l1.clear();
  l2Probe = null;
  ledger = newLedger('');
}

/** Test seam: look at L1 without the side effects of `get`. */
export function peekL1(key: string): CacheEntry<unknown> | undefined {
  return l1.get(key);
}
