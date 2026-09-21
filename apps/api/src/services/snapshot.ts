import type {
  Envelope,
  RankingState,
  RankingsSnapshot,
  Season,
  TeamIdentity,
  TeamSnapshot,
} from '@cfb/shared';
import { seasonKey } from '@cfb/shared';
import { cacheKey, policyFor } from '../cache/policy';
import type { CacheRead, CacheStatus } from '../cache/swr';
import type { Services } from './context';
import { deriveSlots } from './derive';
import { composeCacheStatus, composeFreshness, readLiveSchedule } from './live';

/**
 * One team card's worth of sports data (§6, §13), assembled from cached parts:
 *
 *   schedule  → previous, next, live, bye, record     (15 min, required)
 *   slate     → live status, score, clock              (25 s, only near kickoff)
 *   rankings  → rank and poll name                     (1 h, shared by every team)
 *
 * The schedule is required: without it there is no honest way to say anything
 * about games, so the snapshot fails and carries the reason (§38). Rankings
 * are not: if they fail, the rank shows "—" and the rest of the card stands
 * (§42, "if ranking data is missing").
 */

export interface SnapshotResult {
  envelope: Envelope<TeamSnapshot>;
  cacheStatus: CacheStatus;
}

export function readRankings(
  services: Services,
  season: Season,
): Promise<CacheRead<RankingsSnapshot | null>> {
  const { cache, provider } = services;
  return cache.read({
    key: cacheKey('rankings', provider.name, seasonKey(season)),
    policyFor: () => policyFor('rankings', { seasonType: season.type }),
    load: () => provider.getRankings(season),
  });
}

/**
 * §7: three states, and the difference between the last two is the point.
 * A poll we read that does not list the team is evidence of "unranked". A poll
 * we could not read, or no poll for this season, is evidence of nothing.
 */
export function rankingOf(providerTeamId: string, rankings: RankingsSnapshot | null): RankingState {
  if (rankings === null) return { kind: 'unavailable' };
  const entry = rankings.teams.find((team) => team.providerTeamId === providerTeamId);
  return entry === undefined
    ? { kind: 'unranked' }
    : { kind: 'ranked', rank: entry.rank, poll: rankings.poll, week: rankings.week };
}

/**
 * Identity as the wire carries it (§45): from Postgres for a stored team, from
 * the provider's team list for one nobody has selected.
 *
 * The explicit field copy is load-bearing, not ceremony. `team` is often a
 * `Team`, which is a `TeamIdentity` plus our uuid; spreading it would put `id`
 * inside `snapshot.identity` on every board card, and TypeScript cannot see
 * that because excess properties survive at runtime.
 */
function identityOf(team: TeamIdentity): TeamIdentity {
  return {
    provider: team.provider,
    providerTeamId: team.providerTeamId,
    name: team.name,
    displayName: team.displayName,
    abbreviation: team.abbreviation,
    logoUrl: team.logoUrl,
    conference: team.conference,
    primaryColor: team.primaryColor,
    altColor: team.altColor,
  };
}

export async function buildSnapshot(
  services: Services,
  team: TeamIdentity,
  season: Season,
  rankingsRead?: Promise<CacheRead<RankingsSnapshot | null>>,
): Promise<SnapshotResult> {
  const [live, rankings] = await Promise.all([
    readLiveSchedule(services, team.providerTeamId, season),
    rankingsRead ?? readRankings(services, season),
  ]);
  const statuses = [
    live.schedule.status,
    ...live.slates.map((slate) => slate.status),
    rankings.status,
  ];

  const scheduleData = live.schedule.envelope.data;
  if (scheduleData === null || live.games === null) {
    const { freshness, error } = live.schedule.envelope;
    return {
      envelope: { data: null, freshness, error },
      cacheStatus: composeCacheStatus(statuses),
    };
  }

  const slots = deriveSlots(live.games, team.providerTeamId, {
    now: services.now(),
    season,
    complete: scheduleData.droppedEvents === 0,
  });

  const snapshot: TeamSnapshot = {
    identity: identityOf(team),
    record: slots.record,
    ranking: rankingOf(team.providerTeamId, rankings.envelope.data),
    previousGame: slots.previousGame,
    nextGame: slots.nextGame,
    liveGame: slots.liveGame,
    liveUpdatedAt:
      slots.liveGame === null ? null : (live.overlaidAt.get(slots.liveGame.providerGameId) ?? null),
  };

  const freshness = composeFreshness({
    provider: services.provider.name,
    primary: [live.schedule.envelope.freshness, ...live.usedSlates.map((slate) => slate.freshness)],
    reference: [rankings.envelope.freshness],
    forceStale: live.liveUnverified,
  });

  return {
    envelope: { data: snapshot, freshness, error: null },
    cacheStatus: composeCacheStatus(statuses),
  };
}
