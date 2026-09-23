import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, queryKeys } from '../../lib/api';

/**
 * Matches the API's `SEARCH_MIN_LENGTH` (`apps/api/src/services/search.ts`).
 * Below it the API answers 400, so below it this page must not ask: a 400 per
 * keystroke is the failure mode this constant exists to prevent.
 */
export const MIN_QUERY = 2;

/** One quarter-second of quiet before asking (plan-search-engine, Risks). */
export const DEBOUNCE_MS = 250;

/** The team list behind the answer is cached for a day on the server. */
const RESULTS_STALE_MS = 5 * 60_000;

/**
 * The results for a settled query, or nothing at all while it is too short.
 *
 * Four things together are what keep a person's typing inside the per-address
 * read budget (120/minute): the caller's debounce, the normalized key below,
 * this `staleTime`, and the response's own five-minute `Cache-Control`. A
 * realistic search is two to four requests, and backtracking over a prefix
 * costs none.
 */
export function useTeamSearch(query: string) {
  const normalized = query.trim().toLowerCase();
  const ready = normalized.length >= MIN_QUERY;

  return useQuery({
    queryKey: queryKeys.search(normalized),
    queryFn: ({ signal }) => api.searchTeams(normalized, signal),
    enabled: ready,
    staleTime: RESULTS_STALE_MS,
    // Keep the last results on screen while the next ones load: no flicker,
    // and no empty list between two keystrokes.
    placeholderData: keepPreviousData,
  });
}
