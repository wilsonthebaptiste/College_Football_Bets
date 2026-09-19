import type { ProviderName, SeasonType } from '@cfb/shared';

/**
 * The TTL table: the single source of truth for how long each kind of sports
 * data lives (§23, §24, §25; plan §7). Change a number here and every route,
 * tier, and `Cache-Control` header follows.
 */

export type CacheCategory =
  | 'team_list'
  | 'season_calendar'
  | 'rankings'
  | 'schedule'
  | 'completed_game'
  | 'upcoming_game'
  | 'live_game'
  | 'prediction'
  | 'board_composite';

export type CacheTier = 'l1' | 'l2' | 'l3';

export interface CachePolicy {
  category: CacheCategory;
  /** Inside this window a cached value is served as-is. */
  ttlSeconds: number;
  /**
   * Past the TTL, a value may still be served, marked `stale`, but ONLY when a
   * refresh has just failed (§39). Past this window it is discarded and the
   * answer is `unavailable`.
   */
  staleSeconds: number;
  tiers: readonly CacheTier[];
  /**
   * L3 only: the minimum time between KV writes of the same key.
   *
   * This column is not in plan §7's table, and the KV budget is why it has to
   * exist. The free tier allows about 1,000 writes a day. A schedule with a
   * 15-minute TTL, refreshed on demand for 50 teams through a Saturday, would
   * spend several times that. KV is the durable copy (it survives isolate churn
   * and backs the stale fallback), not the hot copy, so it is updated at most
   * this often. L1 still refreshes at the TTL.
   */
  kvWriteIntervalSeconds: number;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DURABLE: readonly CacheTier[] = ['l1', 'l2', 'l3'];
/** Short-lived data never reaches KV (plan §7: 25 s polling would exhaust the daily budget). */
const EPHEMERAL: readonly CacheTier[] = ['l1'];

type PolicyRow = Omit<CachePolicy, 'category'>;

const TABLE: Readonly<Record<CacheCategory, PolicyRow>> = {
  team_list: {
    ttlSeconds: DAY,
    staleSeconds: 7 * DAY,
    tiers: DURABLE,
    kvWriteIntervalSeconds: DAY,
  },
  season_calendar: {
    ttlSeconds: 6 * HOUR,
    staleSeconds: 7 * DAY,
    tiers: DURABLE,
    kvWriteIntervalSeconds: 6 * HOUR,
  },
  rankings: { ttlSeconds: HOUR, staleSeconds: DAY, tiers: DURABLE, kvWriteIntervalSeconds: HOUR },
  schedule: {
    ttlSeconds: 15 * MINUTE,
    staleSeconds: 6 * HOUR,
    tiers: DURABLE,
    kvWriteIntervalSeconds: HOUR,
  },
  completed_game: {
    ttlSeconds: 7 * DAY,
    staleSeconds: 30 * DAY,
    tiers: DURABLE,
    kvWriteIntervalSeconds: 7 * DAY,
  },
  upcoming_game: {
    ttlSeconds: 10 * MINUTE,
    staleSeconds: 2 * HOUR,
    tiers: DURABLE,
    kvWriteIntervalSeconds: HOUR,
  },
  live_game: {
    ttlSeconds: 25,
    staleSeconds: 2 * MINUTE,
    tiers: EPHEMERAL,
    kvWriteIntervalSeconds: 0,
  },
  prediction: {
    ttlSeconds: 30 * MINUTE,
    staleSeconds: 12 * HOUR,
    tiers: DURABLE,
    kvWriteIntervalSeconds: 2 * HOUR,
  },
  board_composite: {
    ttlSeconds: 60,
    staleSeconds: 5 * MINUTE,
    tiers: EPHEMERAL,
    kvWriteIntervalSeconds: 0,
  },
};

/** Rankings move weekly in season and not at all out of it (plan §7: 1 h, 6 h offseason). */
const RANKINGS_OFFSEASON_TTL = 6 * HOUR;
/**
 * The board refreshes faster while any of its teams is playing (§24), and while
 * any of its cards is failing or stale: a recovered provider should reach the
 * board within seconds, not a minute later. The same 15 s also caps how often
 * a board asks a provider that is down.
 */
const BOARD_SHORT_TTL = 15;

export interface PolicyContext {
  seasonType?: SeasonType;
  anyLive?: boolean;
  /** Board only: some card is `unavailable` or `stale`. */
  degraded?: boolean;
}

export function policyFor(category: CacheCategory, context: PolicyContext = {}): CachePolicy {
  const row = TABLE[category];
  let { ttlSeconds } = row;
  if (
    category === 'rankings' &&
    context.seasonType !== undefined &&
    context.seasonType !== 'regular'
  ) {
    ttlSeconds = RANKINGS_OFFSEASON_TTL;
  }
  if (category === 'board_composite' && (context.anyLive === true || context.degraded === true)) {
    ttlSeconds = BOARD_SHORT_TTL;
  }
  return { ...row, category, ttlSeconds };
}

/** The floor below which `tiers.ts` refuses a KV write, whatever a policy says (plan §7). */
export const L3_MIN_TTL_SECONDS = 300;

// ─── Keys ────────────────────────────────────────────────────────────────────

/**
 * What a key names. Distinct from `CacheCategory` because one resource can land
 * in several categories: a game's TTL depends on whether it is final, live, or
 * upcoming, which is only known after it is fetched.
 */
export type CacheResource =
  | 'team_list'
  | 'season_calendar'
  | 'rankings'
  | 'schedule'
  | 'slate'
  | 'game'
  | 'prediction'
  | 'board';

/** Bump when a cached value's shape changes, so KV never serves an old shape. */
const KEY_VERSION = 'v2';

/**
 * `cacheKey('schedule', 'espn', seasonKey(season), '251')` → `v2|espn|schedule|<year>:regular|251`
 *
 * The provider is always part of the key, so switching `SPORTS_PROVIDER` can
 * never serve one provider's data labelled as the other's. Season-scoped
 * resources take `seasonKey(season)` as a part (§21).
 */
export function cacheKey(
  resource: CacheResource,
  provider: ProviderName,
  ...parts: string[]
): string {
  return [KEY_VERSION, provider, resource, ...parts].join('|');
}
