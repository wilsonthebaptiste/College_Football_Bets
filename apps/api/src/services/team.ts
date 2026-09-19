import type {
  ScheduleResult,
  TeamDetailResponse,
  TeamScheduleResponse,
  Envelope,
} from '@cfb/shared';
import type { CacheStatus } from '../cache/swr';
import type { PostgrestClient } from '../db/postgrest';
import { getTeamById } from '../db/queries';
import { resolveSeason } from '../season/resolve';
import type { Services } from './context';
import { scheduleItems } from './derive';
import { composeCacheStatus, composeFreshness, readLiveSchedule } from './live';
import { buildSnapshot } from './snapshot';

/**
 * The team page's two reads (§16, §17). They are separate routes on purpose:
 * the schedule is lazy-loaded when the page mounts, not with the board (§27),
 * and a failed schedule must not blank the hero (§42).
 *
 * Team identity comes from Postgres and is always present. Only the
 * provider-owned half can be missing, and that half is an envelope.
 */

export interface TeamResult<T> {
  body: T;
  cacheStatus: CacheStatus;
}

export async function getTeamDetail(
  services: Services,
  db: PostgrestClient,
  teamId: string,
): Promise<TeamResult<TeamDetailResponse>> {
  const [team, { season }] = await Promise.all([getTeamById(db, teamId), resolveSeason(services)]);
  const snapshot = await buildSnapshot(services, team, season);
  return { body: { team, season, snapshot: snapshot.envelope }, cacheStatus: snapshot.cacheStatus };
}

export async function getTeamSchedule(
  services: Services,
  db: PostgrestClient,
  teamId: string,
): Promise<TeamResult<TeamScheduleResponse>> {
  const [team, { season }] = await Promise.all([getTeamById(db, teamId), resolveSeason(services)]);
  const live = await readLiveSchedule(services, team.providerTeamId, season);
  const cacheStatus = composeCacheStatus([
    live.schedule.status,
    ...live.slates.map((slate) => slate.status),
  ]);

  const data = live.schedule.envelope.data;
  if (data === null || live.games === null) {
    const { freshness, error } = live.schedule.envelope;
    return { body: { team, schedule: { data: null, freshness, error } }, cacheStatus };
  }

  const schedule: Envelope<ScheduleResult> = {
    data: {
      season: data.season,
      items: scheduleItems(live.games, team.providerTeamId, data.droppedEvents === 0),
    },
    freshness: composeFreshness({
      provider: services.provider.name,
      primary: [
        live.schedule.envelope.freshness,
        ...live.usedSlates.map((slate) => slate.freshness),
      ],
      reference: [],
      forceStale: live.liveUnverified,
    }),
    error: null,
  };
  return { body: { team, schedule }, cacheStatus };
}
