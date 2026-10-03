import { useQuery } from '@tanstack/react-query';
import { api, queryKeys } from '../../lib/api';
import { POLL } from '../../lib/poll';

/**
 * One team's projected points (predicting_score.md, Phase 4), by whichever of
 * the team's two addresses the page was opened at — the API resolves both, so
 * this starts on mount alongside the team and schedule reads instead of
 * waiting for the team to name its provider id.
 */
export function useTeamProjection(teamId: string) {
  return useQuery({
    queryKey: queryKeys.teamProjection(teamId),
    queryFn: ({ signal }) => api.teamProjection(teamId, signal),
    staleTime: POLL.projectionMs,
    refetchInterval: POLL.projectionMs,
  });
}
