import type { TeamOwner } from '@cfb/shared';
import { useQuery } from '@tanstack/react-query';
import { api, queryKeys } from './api';

/** One frozen empty list, so "nobody has it" is a stable reference, not a new array a render. */
const NONE: readonly TeamOwner[] = [];

/** The index changes only when the administrator changes a board (project notes §8). */
const OWNERS_STALE_MS = 5 * 60_000;

/**
 * Who has each team, by PROVIDER team id (plan-search-engine, Part Two).
 *
 * Loading, failed, and "nobody has this team" are the same answer on purpose:
 * all three return an empty list, and an empty list renders nothing at all.
 * Owners are garnish (§38, §42) — a slow or broken index must cost the page
 * that uses it nothing, so there is no error state to show and nothing to wait
 * for. The cost of that is real and accepted: a broken index is invisible,
 * which is why it is drilled rather than trusted.
 *
 * It is its own query, never combined with the caller's: gating a search on
 * this would put a Postgres read in front of every keystroke, which is the one
 * thing Phase 2 bought by keeping the search route off Postgres entirely.
 *
 * In `lib/` rather than beside a feature because two features use it: the
 * search results and, in Phase 7, the team page.
 */
export function useTeamOwners(): (providerTeamId: string) => readonly TeamOwner[] {
  const { data } = useQuery({
    queryKey: queryKeys.owners,
    queryFn: ({ signal }) => api.teamOwners(signal),
    staleTime: OWNERS_STALE_MS,
  });

  return (providerTeamId) => data?.owners[providerTeamId] ?? NONE;
}
