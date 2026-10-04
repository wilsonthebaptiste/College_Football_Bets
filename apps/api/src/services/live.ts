import type { Envelope, Freshness, FreshnessState, Season } from '@cfb/shared';
import { seasonKey } from '@cfb/shared';
import { cacheKey, policyFor } from '../cache/policy';
import type { CacheRead, CacheStatus } from '../cache/swr';
import type { ProviderGame, ProviderSchedule } from '../providers/types';
import type { Services } from './context';
import { inLiveWindow } from './derive';

/**
 * Games with live scores laid over them: a team's schedule, or a week.
 *
 * The schedule is cached for 15 minutes; a live score for 25 seconds. Rather
 * than refetching a 500 KB schedule every 25 seconds per team, the games that
 * might be in progress are looked up in their SLATE, one request per slate,
 * shared by every team playing that day (plan §6, "Live slate"). Status,
 * clock, score, verdict, and record come from the slate; everything else stays
 * from the schedule.
 */

/**
 * Live data laid over a set of games: the reusable half of the overlay. A
 * team's schedule uses it (`readLiveSchedule`), and so does a week of games
 * (`services/matchups.ts`) — through the SAME slate cache key, so a Saturday's
 * boards and its matchup board share one slate read per isolate.
 */
export interface LiveOverlay {
  /** The games, with the live overlay applied where a usable slate had them. */
  games: ProviderGame[];
  /** Every slate read attempted. They count toward `X-Cache`. */
  slates: CacheRead<ProviderGame[]>[];
  /** The slates whose data was laid over the games. They count toward freshness. */
  usedSlates: Envelope<ProviderGame[]>[];
  /**
   * A game in its live window could not be checked, because its slate was
   * unavailable, or stale and older than the base data. The game may show a
   * pre-game status while in progress, so whatever shows it is marked stale.
   */
  liveUnverified: boolean;
  /** Which games those were, for a caller that marks them one by one. */
  unverified: ReadonlySet<string>;
  /**
   * For each game that got a live overlay, when its slate was fetched from the
   * provider. That is the age of the score and clock on screen, which the
   * composed freshness (the oldest part) cannot tell.
   */
  overlaidAt: ReadonlyMap<string, string | null>;
  /** For each game that got a live overlay, the freshness of the slate it came from. */
  overlaidFreshness: ReadonlyMap<string, Freshness>;
}

export interface LiveSchedule extends Omit<LiveOverlay, 'games'> {
  schedule: CacheRead<ProviderSchedule>;
  /** `null` when the schedule itself is unavailable. */
  games: ProviderGame[] | null;
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
    // Down and distance are as old as the score beside them: the slate's.
    situation: live.situation ?? null,
  };
}

/** ISO timestamps compare correctly as strings. `null` sorts oldest. */
function isNewerOrSame(a: string | null, b: string | null): boolean {
  return a !== null && (b === null || a >= b);
}

function noOverlay(): Omit<LiveOverlay, 'games'> {
  return {
    slates: [],
    usedSlates: [],
    liveUnverified: false,
    unverified: new Set(),
    overlaidAt: new Map(),
    overlaidFreshness: new Map(),
  };
}

/**
 * Lays the live slates over `games`. `baseFetchedAt` is when those games were
 * read (the schedule's or the week document's `fetchedAt`), which is what a
 * stale slate is compared against.
 */
export async function overlayLive(
  services: Services,
  games: readonly ProviderGame[],
  baseFetchedAt: string | null,
): Promise<LiveOverlay> {
  const now = services.now();
  const slateOf = (game: ProviderGame): string => services.provider.slateKeyFor(game.kickoffUtc);
  const candidates = games.filter((game) => inLiveWindow(game, now));
  if (candidates.length === 0) return { ...noOverlay(), games: [...games] };

  const keys = [...new Set(candidates.map(slateOf))];
  const slates = await Promise.all(keys.map((key) => readSlate(services, key)));

  const usable = new Map<
    string,
    { games: Map<string, ProviderGame>; envelope: Envelope<ProviderGame[]> }
  >();
  const usedSlates: Envelope<ProviderGame[]>[] = [];
  slates.forEach((slate, index) => {
    const key = keys[index];
    const slateGames = slate.envelope.data;
    if (key === undefined || slateGames === null) return;
    // A slate kept past its TTL after a failed refresh, and older than the
    // base data, could move a game backwards (live → pre-game), so it is not
    // used at all. One still inside its own TTL is as current as a live score
    // is here, even if the base data arrived a moment after it: rejecting it
    // marked live cards stale on every Saturday schedule refresh. Its score is
    // dated by its own read (`overlaidAt`), never by the base data's.
    const { state, fetchedAt } = slate.envelope.freshness;
    if (state === 'stale' && !isNewerOrSame(fetchedAt, baseFetchedAt)) return;
    usable.set(key, {
      games: new Map(slateGames.map((game) => [game.providerGameId, game])),
      envelope: slate.envelope,
    });
    usedSlates.push(slate.envelope);
  });

  const unverified = new Set<string>();
  const overlaidAt = new Map<string, string | null>();
  const overlaidFreshness = new Map<string, Freshness>();
  const result = games.map((game) => {
    if (!inLiveWindow(game, now)) return game;
    const slate = usable.get(slateOf(game));
    if (slate === undefined) {
      unverified.add(game.providerGameId);
      return game;
    }
    const live = slate.games.get(game.providerGameId);
    // Absent from a good slate is not an error: an FCS-only game is outside
    // groups=80, for one. The base data's own status stands.
    if (live === undefined || !sameMatchup(game, live)) return game;
    overlaidAt.set(game.providerGameId, slate.envelope.freshness.fetchedAt);
    overlaidFreshness.set(game.providerGameId, slate.envelope.freshness);
    return overlay(game, live);
  });

  return {
    games: result,
    slates,
    usedSlates,
    liveUnverified: unverified.size > 0,
    unverified,
    overlaidAt,
    overlaidFreshness,
  };
}

export async function readLiveSchedule(
  services: Services,
  providerTeamId: string,
  season: Season,
): Promise<LiveSchedule> {
  const schedule = await readSchedule(services, providerTeamId, season);
  const data = schedule.envelope.data;
  if (data === null) return { ...noOverlay(), schedule, games: null };
  const live = await overlayLive(services, data.games, schedule.envelope.freshness.fetchedAt);
  return { ...live, schedule };
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
