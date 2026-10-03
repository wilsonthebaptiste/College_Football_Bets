import { useQuery } from '@tanstack/react-query';
import { api, queryKeys } from '../../lib/api';
import { POLL } from '../../lib/poll';

/**
 * One board's projected points (predicting_score.md, Phase 4). Its own request,
 * started alongside the board's and never folded into it (§42): the board is
 * the application's most important read, and a scrape that fails must not be
 * able to touch it.
 *
 * Reread at the idle pace whatever the board is doing. A live game moves the
 * board every 15 seconds and moves this not at all — its inputs are a
 * publisher's daily recompute.
 */
export function useBoardProjection(userId: string) {
  return useQuery({
    queryKey: queryKeys.boardProjection(userId),
    queryFn: ({ signal }) => api.boardProjection(userId, signal),
    staleTime: POLL.projectionMs,
    refetchInterval: POLL.projectionMs,
  });
}
