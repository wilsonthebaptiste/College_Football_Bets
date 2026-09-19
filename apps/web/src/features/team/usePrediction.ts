import { skipToken, useQuery } from '@tanstack/react-query';
import { api, queryKeys } from '../../lib/api';
import { POLL } from '../../lib/poll';

/**
 * §12 — the matchup prediction for one game, by the provider's game id. With
 * no game to ask about (the season is over), nothing is requested at all.
 */
export function usePrediction(providerGameId: string | null) {
  return useQuery({
    queryKey: queryKeys.prediction(providerGameId ?? 'none'),
    queryFn:
      providerGameId === null ? skipToken : ({ signal }) => api.prediction(providerGameId, signal),
    refetchInterval: POLL.predictionMs,
  });
}
