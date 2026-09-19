import { useQuery } from '@tanstack/react-query';
import { api, queryKeys } from '../../lib/api';
import { boardPollInterval, POLL } from '../../lib/poll';

/**
 * §24, §27 — one request for the whole board, refreshed on an interval the
 * board itself decides: 15 s while a team is live, 60 s around game time or
 * while a card is failing, 5 min when nothing is on. Nothing polls while the
 * tab is hidden (global default), and returning to the tab refetches once if
 * the data is older than `POLL.staleTimeMs`.
 */
export function useBoard(userId: string) {
  return useQuery({
    queryKey: queryKeys.board(userId),
    queryFn: ({ signal }) => api.board(userId, signal),
    refetchInterval: (query) => {
      const board = query.state.data;
      // No board yet (the first load failed): keep trying at the ordinary pace.
      return board === undefined ? POLL.activeMs : boardPollInterval(board, Date.now());
    },
  });
}
