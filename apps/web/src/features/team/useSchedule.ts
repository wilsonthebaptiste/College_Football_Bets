import { useQuery } from '@tanstack/react-query';
import { api, queryKeys } from '../../lib/api';
import { POLL, schedulePollInterval } from '../../lib/poll';

/**
 * §17 — the team's full season, fetched when the team page mounts and never
 * with the board (§27, §49). It is its own query, so a failed schedule leaves
 * the rest of the page standing (§42), and the page starts it at the same
 * moment as the team request rather than after it.
 */
export function useSchedule(teamId: string) {
  return useQuery({
    queryKey: queryKeys.schedule(teamId),
    queryFn: ({ signal }) => api.schedule(teamId, signal),
    refetchInterval: (query) => {
      const response = query.state.data;
      return response === undefined
        ? POLL.activeMs
        : schedulePollInterval(response.schedule, Date.now());
    },
  });
}
