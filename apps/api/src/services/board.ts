import type { BoardResponse, BoardTeam, Envelope, Season, TeamSnapshot } from '@cfb/shared';
import { appError, failed } from '@cfb/shared';
import { cacheKey, policyFor } from '../cache/policy';
import type { CacheStatus } from '../cache/swr';
import type { PostgrestClient } from '../db/postgrest';
import { getUserWithSelections } from '../db/queries';
import { HttpError } from '../http/errors';
import { resolveSeason } from '../season/resolve';
import type { Services } from './context';
import { buildSnapshot, readRankings } from './snapshot';

/**
 * `GET /api/users/:userId/board` (§13, §27): one browser request, every team.
 *
 * Selections come from Postgres; each team's snapshot is built in parallel
 * with `Promise.allSettled`, so one team failing cannot take the others with
 * it (§42). Teams shared between boards share cache entries, and concurrent
 * loads of the same key are coalesced (`cache/swr.ts`), so Alabama on four
 * boards is one provider call.
 *
 * The assembled board is itself cached in L1 for 60 s (15 s while any team is
 * live or any card is failing), which is what absorbs polling: a poll inside
 * that window costs neither a Postgres round trip nor a single cache lookup
 * per team.
 */

interface BoardComposite {
  user: BoardResponse['user'];
  season: Season;
  anyLive: boolean;
  teams: BoardTeam[];
}

export interface BoardResult {
  body: BoardResponse;
  cacheStatus: CacheStatus;
  /** Some card is `unavailable` or `stale`: the response should be short-lived. */
  degraded: boolean;
}

function isDegraded(teams: readonly BoardTeam[]): boolean {
  return teams.some(
    (team) =>
      team.snapshot.freshness.state === 'unavailable' || team.snapshot.freshness.state === 'stale',
  );
}

function unexpectedFailure(services: Services): Envelope<TeamSnapshot> {
  // `buildSnapshot` turns every provider failure into an envelope, so reaching
  // here means a bug. Still one card, not the board (§42).
  return failed(
    appError('internal', 'Unable to load team information.', services.requestId),
    services.provider.name,
  );
}

async function assemble(
  services: Services,
  db: PostgrestClient,
  userId: string,
): Promise<BoardComposite> {
  const [{ user, selections }, { season }] = await Promise.all([
    getUserWithSelections(db, userId),
    resolveSeason(services),
  ]);

  // One rankings read for the whole board, so all six cards quote the same poll.
  const rankings = readRankings(services, season);
  const settled = await Promise.allSettled(
    selections.map((selection) => buildSnapshot(services, selection.team, season, rankings)),
  );

  const teams: BoardTeam[] = selections.map((selection, index) => {
    const outcome = settled[index];
    if (outcome?.status === 'rejected') {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'snapshot_threw',
          requestId: services.requestId,
          team: selection.team.providerTeamId,
          detail: String(outcome.reason),
        }),
      );
    }
    return {
      selectionId: selection.id,
      order: selection.order,
      team: selection.team,
      snapshot:
        outcome?.status === 'fulfilled' ? outcome.value.envelope : unexpectedFailure(services),
    };
  });

  return {
    user,
    season,
    anyLive: teams.some((team) => team.snapshot.data?.liveGame != null),
    teams,
  };
}

/**
 * A board served from its own cache repeats snapshots that were `fresh` when
 * assembled. They are now `cached`, or `stale` if the board itself is.
 * `fetchedAt` is untouched either way (§39).
 */
function relabel(team: BoardTeam, state: 'cached' | 'stale'): BoardTeam {
  const { freshness } = team.snapshot;
  if (freshness.state === 'unavailable') return team;
  if (state === 'cached' && freshness.state !== 'fresh') return team;
  return {
    ...team,
    snapshot: { ...team.snapshot, freshness: { ...freshness, state, source: 'cache' } },
  };
}

export async function getBoard(
  services: Services,
  db: PostgrestClient,
  userId: string,
): Promise<BoardResult> {
  const read = await services.cache.read<BoardComposite>({
    key: cacheKey('board', services.provider.name, userId),
    policyFor: (board) =>
      policyFor('board_composite', { anyLive: board.anyLive, degraded: isDegraded(board.teams) }),
    load: () => assemble(services, db, userId),
    // A board for a user who does not exist is a 404, never a stale copy.
    isFatal: (error) => error instanceof HttpError && error.kind === 'not_found',
    // The board is the whole response; with nothing to show, the database
    // error goes to the error handler with its own status and message.
    whenUnavailable: 'throw',
  });

  const composite = read.envelope.data;
  if (composite === null) {
    throw new HttpError('internal', 'Unable to load this board.');
  }

  const teams =
    read.status === 'hit'
      ? composite.teams.map((team) => relabel(team, 'cached'))
      : read.status === 'stale'
        ? composite.teams.map((team) => relabel(team, 'stale'))
        : composite.teams;

  // `X-Cache` describes what the response is made of. A freshly assembled board
  // whose cards fell back to stale data is a stale response.
  const anyTeamStale = teams.some((team) => team.snapshot.freshness.state === 'stale');

  return {
    body: {
      user: composite.user,
      season: composite.season,
      generatedAt: new Date(services.now()).toISOString(),
      freshness: read.envelope.freshness,
      anyLive: composite.anyLive,
      teams,
    },
    cacheStatus: anyTeamStale ? 'stale' : read.status,
    degraded: isDegraded(teams),
  };
}
