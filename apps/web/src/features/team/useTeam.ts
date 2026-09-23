import type { BoardResponse, TeamDetailResponse } from '@cfb/shared';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, queryKeys } from '../../lib/api';
import { pollIntervalFor, POLL } from '../../lib/poll';

/**
 * A board card already holds this team's identity and snapshot, in exactly the
 * shape the team route returns. Showing it while the team request is in flight
 * makes board → team instant; the real response replaces it a moment later.
 *
 * Either id matches, because since Phase 1 a team page has two addresses: our
 * uuid (what a board card links to) and the provider's id (what a search
 * result links to). A team that happens to be on a loaded board paints
 * instantly whichever door it was opened through.
 */
function fromLoadedBoards(
  queryClient: QueryClient,
  teamId: string,
): TeamDetailResponse | undefined {
  for (const [, board] of queryClient.getQueriesData<BoardResponse>({
    queryKey: queryKeys.boards,
  })) {
    const entry = board?.teams.find(
      (candidate) => candidate.team.id === teamId || candidate.team.providerTeamId === teamId,
    );
    if (board !== undefined && entry !== undefined) {
      return { team: entry.team, season: board.season, snapshot: entry.snapshot };
    }
  }
  return undefined;
}

export function useTeam(teamId: string) {
  const queryClient = useQueryClient();
  return useQuery<TeamDetailResponse>({
    queryKey: queryKeys.team(teamId),
    queryFn: ({ signal }) => api.team(teamId, signal),
    placeholderData: () => fromLoadedBoards(queryClient, teamId),
    refetchInterval: (query) => {
      const detail = query.state.data;
      return detail === undefined ? POLL.activeMs : pollIntervalFor([detail.snapshot], Date.now());
    },
  });
}
