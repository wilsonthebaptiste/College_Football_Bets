import type { MatchupBoardResponse, MatchupResponse } from '@cfb/shared';
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, queryKeys } from '../../lib/api';
import { matchupBoardPollInterval, matchupPollInterval, POLL } from '../../lib/poll';

/**
 * The matchup board's one request (plan-matchup-board, Phase 2), refreshed on
 * the interval the board itself decides — the board's rules and constants,
 * so the two screens agree. Nothing polls while the tab is hidden (the app's
 * default, `lib/queryClient.ts`), and returning to it refetches once.
 *
 * Exported as options as well as a hook so the hidden-tab test can drive the
 * real `QueryClient` with exactly what the page uses.
 */
export function matchupBoardQuery(week: string | null) {
  return queryOptions({
    queryKey: queryKeys.matchupBoard(week),
    queryFn: ({ signal }) => api.matchups(week, signal),
    refetchInterval: (query) => {
      const board = query.state.data;
      // No board yet (the first load failed): keep trying at the ordinary pace.
      return board === undefined ? POLL.activeMs : matchupBoardPollInterval(board, Date.now());
    },
  });
}

export function useMatchupBoard(week: string | null) {
  return useQuery(matchupBoardQuery(week));
}

/**
 * A loaded matchup board already holds this game's row, in exactly the shape
 * the game route returns. Showing it while the game request is in flight makes
 * board → game instant, as board → team is (`useTeam`).
 */
function fromLoadedBoards(
  queryClient: QueryClient,
  providerGameId: string,
): MatchupResponse | undefined {
  for (const [, board] of queryClient.getQueriesData<MatchupBoardResponse>({
    queryKey: queryKeys.matchups,
  })) {
    // The prefix also matches single games, which have no `matchups` list.
    const row = board?.matchups?.find((candidate) => candidate.providerGameId === providerGameId);
    if (board !== undefined && row !== undefined) {
      return { season: board.season, generatedAt: board.generatedAt, matchup: row };
    }
  }
  return undefined;
}

/** One game's page, polled as the team page polls its snapshot (15 s while live). */
export function useMatchup(providerGameId: string) {
  const queryClient = useQueryClient();
  return useQuery<MatchupResponse>({
    queryKey: queryKeys.matchup(providerGameId),
    queryFn: ({ signal }) => api.matchup(providerGameId, signal),
    placeholderData: () => fromLoadedBoards(queryClient, providerGameId),
    refetchInterval: (query) => {
      const response = query.state.data;
      return response === undefined
        ? POLL.activeMs
        : matchupPollInterval(response.matchup, Date.now());
    },
  });
}
