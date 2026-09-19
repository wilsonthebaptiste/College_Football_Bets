import type { Envelope, Freshness, FreshnessState, Season } from '@cfb/shared';
import { seasonKey } from '@cfb/shared';
import { cacheKey, policyFor } from '../cache/policy';
import type { CacheRead, CacheStatus } from '../cache/swr';
import type { ProviderGame, ProviderSchedule } from '../providers/types';
import type { Services } from './context';
import { inLiveWindow } from './derive';

/**
 * A team's schedule with live scores laid over it.
 *
 * The schedule is cached for 15 minutes; a live score for 25 seconds. Rather
 * than refetching a 500 KB schedule every 25 seconds per team, the games that
 * might be in progress are looked up in their SLATE, one request per slate,
 * shared by every team playing that day (plan §6, "Live slate"). Status,
 * clock, score, verdict, and record come from the slate; everything else stays
 * from the schedule.
 */

export interface LiveSchedule {
  schedule: CacheRead<ProviderSchedule>;
  /** `null` when the schedule itself is unavailable. */
  games: ProviderGame[] | null;
  /** Every slate read attempted. They count toward `X-Cache`. */
  slates: CacheRead<ProviderGame[]>[];
  /** The slates whose data was laid over the schedule. They count toward freshness. */
  usedSlates: Envelope<ProviderGame[]>[];
  /**
   * A game in its live window could not be checked, because its slate was
   * unavailable or older than the schedule. The card may show a pre-game
   * status for a game in progress, so the whole snapshot is marked stale.
   */
  liveUnverified: boolean;
}

export async function readSchedule(
  services: Services,
  providerTeamId: string,
  season: Season,
): Promise<CacheRead<ProviderSchedule>> {
  const { cache, provider } = services;
  return cache.read({
    key: cacheKey('schedule', provider.name, seasonKey(season), providerTeamId),
    policyFor: () => policyFor('schedule'),
    load: () => provider.getTeamSchedule(providerTeamId, season),
  });
}

function readSlate(services: Services, slateKey: string): Promise<CacheRead<ProviderGame[]>> {
  const { cache, provider } = services;
  return cache.read({
    key: cacheKey('slate', provider.name, slateKey),
    policyFor: () => policyFor('live_game'),
    load: () => provider.getSlate(slateKey),
  });
}

function sameMatchup(a: ProviderGame, b: ProviderGame): boolean {
  return (
    a.home.team.providerTeamId === b.home.team.providerTeamId &&
    a.away.team.providerTeamId === b.away.team.providerTeamId
  );
}

function overlay(base: ProviderGame, live: ProviderGame): ProviderGame {
  return {
    ...base,
    status: live.status,
    statusDetail: live.statusDetail,
    period: live.period,
    clock: live.clock,
    home: {
      ...base.home,
      score: live.home.score,
      winner: live.home.winner,
      record: live.home.record ?? base.home.record,
    },
    away: {
      ...base.away,
      score: live.away.score,
      winner: live.away.winner,
      record: live.away.record ?? base.away.record,
    },
  };
}

/** ISO timestamps compare correctly as strings. `null` sorts oldest. */
function isNewerOrSame(a: string | null, b: string | null): boolean {
  return a !== null && (b === null || a >= b);
}

export async function readLiveSchedule(
  services: Services,
  providerTeamId: string,
  season: Season,
): Promise<LiveSchedule> {
  const schedule = await readSchedule(services, providerTeamId, season);
  const data = schedule.envelope.data;
  const none = { slates: [], usedSlates: [], liveUnverified: false };
  if (data === null) return { schedule, games: null, ...none };

  const now = services.now();
  const slateOf = (game: ProviderGame): string => services.provider.slateKeyFor(game.kickoffUtc);
  const candidates = data.games.filter((game) => inLiveWindow(game, now));
  if (candidates.length === 0) return { schedule, games: data.games, ...none };

  const keys = [...new Set(candidates.map(slateOf))];
  const slates = await Promise.all(keys.map((key) => readSlate(services, key)));

  const scheduleFetchedAt = schedule.envelope.freshness.fetchedAt;
  const usable = new Map<string, Map<string, ProviderGame>>();
  const usedSlates: Envelope<ProviderGame[]>[] = [];
  slates.forEach((slate, index) => {
    const key = keys[index];
    const games = slate.envelope.data;
    // A slate older than the schedule could move a game backwards (live →
    // pre-game), so it is not used at all.
    if (key === undefined || games === null) return;
    if (!isNewerOrSame(slate.envelope.freshness.fetchedAt, scheduleFetchedAt)) return;
    usable.set(key, new Map(games.map((game) => [game.providerGameId, game])));
    usedSlates.push(slate.envelope);
  });

  let liveUnverified = false;
  const games = data.games.map((game) => {
    if (!inLiveWindow(game, now)) return game;
    const slate = usable.get(slateOf(game));
    if (slate === undefined) {
      liveUnverified = true;
      return game;
    }
    const live = slate.get(game.providerGameId);
    // Absent from a good slate is not an error: an FCS-only game is outside
    // groups=80, for one. The schedule's own status stands.
    return live !== undefined && sameMatchup(game, live) ? overlay(game, live) : game;
  });

  return { schedule, games, slates, usedSlates, liveUnverified };
}

// ─── Freshness of a composite ────────────────────────────────────────────────

const STATE_RANK: Record<FreshnessState, number> = {
  fresh: 0,
  cached: 1,
  stale: 2,
  unavailable: 3,
};

export interface ComposeParts {
  provider: Freshness['provider'];
  /** Parts whose data is ON the card: schedule, applied slates. They set the timestamp. */
  primary: readonly Freshness[];
  /**
   * Parts that feed one field and change slowly: rankings. They can make the
   * composite stale, but do not drag its timestamp back. A poll fetched 50
   * minutes ago (inside its 1 h TTL) is current, and letting it age every card
   * by 50 minutes would make a live Saturday look an hour old.
   */
  reference: readonly Freshness[];
  forceStale: boolean;
}

/**
 * One `Freshness` for data assembled from several cache reads.
 *   state      the worst of the primary parts (stale > cached > fresh), or
 *              stale if any reference part is
 *   fetchedAt  the OLDEST primary part: nothing on the card is older than this
 *   expiresAt  the earliest expiry: when any of it is due for a refresh
 * Conservative in every direction, because §39 forbids the opposite error.
 */
export function composeFreshness(parts: ComposeParts): Freshness {
  let worst: FreshnessState = 'fresh';
  for (const part of parts.primary) {
    if (part.state !== 'unavailable' && STATE_RANK[part.state] > STATE_RANK[worst]) {
      worst = part.state;
    }
  }
  // A reference read served from cache is simply current. Only a failure
  // behind it (stale) is news; `cached` would contradict the primary
  // timestamp, which may be this request's own.
  if (parts.forceStale || parts.reference.some((part) => part.state === 'stale')) {
    worst = 'stale';
  }

  const fetched = parts.primary
    .map((part) => part.fetchedAt)
    .filter((at): at is string => at !== null);
  const expiries = parts.primary
    .map((part) => part.expiresAt)
    .filter((at): at is string => at !== null);
  const ttls = parts.primary.map((part) => part.ttlSeconds);

  return {
    state: worst,
    fetchedAt: fetched.length > 0 ? fetched.reduce((a, b) => (a < b ? a : b)) : null,
    ttlSeconds: ttls.length > 0 ? Math.min(...ttls) : 0,
    expiresAt: expiries.length > 0 ? expiries.reduce((a, b) => (a < b ? a : b)) : null,
    source: worst === 'fresh' ? 'provider' : 'cache',
    provider: parts.provider,
  };
}

/** `X-Cache` for a composite: stale if anything was, miss if anything was fetched, else hit. */
export function composeCacheStatus(statuses: readonly CacheStatus[]): CacheStatus {
  if (statuses.includes('stale')) return 'stale';
  if (statuses.includes('miss') || statuses.includes('unavailable')) return 'miss';
  return 'hit';
}
