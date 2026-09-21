import type {
  PageTeam,
  ScheduleResult,
  TeamDetailResponse,
  TeamScheduleResponse,
  Envelope,
} from '@cfb/shared';
import type { CacheStatus } from '../cache/swr';
import type { PostgrestClient } from '../db/postgrest';
import { getTeamById, isUuid } from '../db/queries';
import { notFound } from '../http/errors';
import { isProviderId } from '../providers/ids';
import { sizedLogoUrl, TEAM_LOGO_PX } from '../providers/logos';
import { resolveSeason } from '../season/resolve';
import type { Services } from './context';
import { scheduleItems } from './derive';
import { composeCacheStatus, composeFreshness, readLiveSchedule } from './live';
import { findTeamIdentity } from './search';
import { buildSnapshot } from './snapshot';

/**
 * The team page's two reads (§16, §17). They are separate routes on purpose:
 * the schedule is lazy-loaded when the page mounts, not with the board (§27),
 * and a failed schedule must not blank the hero (§42).
 *
 * Identity is always present. Only the provider-owned half can be missing, and
 * that half is an envelope.
 */

export interface TeamResult<T> {
  body: T;
  cacheStatus: CacheStatus;
}

/**
 * A database client, built only if the lookup turns out to need one. Asking for
 * a client is what checks that Supabase is configured at all, and a provider-id
 * page never touches Postgres, so it must not be asked.
 */
export type DbFactory = () => PostgrestClient;

/**
 * The team a `:teamId` names, by either of the two ids a team can be known by.
 *
 * The uuid is tried FIRST and never falls through. A uuid also matches the
 * provider-id pattern, so a fallback would mean a team whose row was deleted
 * quietly starting to resolve as some provider's team id — and there is no id
 * shape that tells the two apart.
 *
 * A provider id needs no database access at all: the 24-hour team list already
 * holds every identity (`findTeamIdentity`). That is the whole reason any team
 * can have a page — and it is also why a public lookup can never create a
 * `teams` row (§30, §31). The asymmetry it buys: a stored team still shows its
 * identity when the provider is down, a searched one does not.
 */
export async function resolveTeam(
  services: Services,
  db: DbFactory,
  teamId: string,
): Promise<PageTeam> {
  if (isUuid(teamId)) return await getTeamById(db(), teamId);
  if (!isProviderId(teamId)) throw notFound('No such team.');

  const identity = await findTeamIdentity(services, teamId);
  if (identity === null) throw notFound('No such team.');
  // Sized on the way out, exactly as `db/rows.ts toTeam` sizes a stored row (§49).
  return { ...identity, id: null, logoUrl: sizedLogoUrl(identity.logoUrl, TEAM_LOGO_PX) };
}

export async function getTeamDetail(
  services: Services,
  db: DbFactory,
  teamId: string,
): Promise<TeamResult<TeamDetailResponse>> {
  const [team, { season }] = await Promise.all([
    resolveTeam(services, db, teamId),
    resolveSeason(services),
  ]);
  const snapshot = await buildSnapshot(services, team, season);
  return { body: { team, season, snapshot: snapshot.envelope }, cacheStatus: snapshot.cacheStatus };
}

export async function getTeamSchedule(
  services: Services,
  db: DbFactory,
  teamId: string,
): Promise<TeamResult<TeamScheduleResponse>> {
  const [team, { season }] = await Promise.all([
    resolveTeam(services, db, teamId),
    resolveSeason(services),
  ]);
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
