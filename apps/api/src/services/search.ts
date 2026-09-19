import type { TeamIdentity } from '@cfb/shared';
import { cacheKey, policyFor } from '../cache/policy';
import { HttpError, invalidRequest } from '../http/errors';
import type { Services } from './context';

/**
 * Admin team search (§43): the provider's full team list, fetched once and
 * cached for 24 hours, filtered here. 762 teams is a list, not a search engine.
 */

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 60;
export const SEARCH_LIMIT = 20;

/** Case- and accent-insensitive: "san jose" finds "San José State". */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function parseQuery(raw: string | undefined): string {
  const query = fold(raw ?? '');
  if (query.length < SEARCH_MIN_LENGTH || query.length > SEARCH_MAX_LENGTH) {
    throw invalidRequest(
      `q must be between ${String(SEARCH_MIN_LENGTH)} and ${String(SEARCH_MAX_LENGTH)} characters.`,
    );
  }
  return query;
}

/** Lower is better. `null` means no match. */
function score(team: TeamIdentity, query: string): number | null {
  const abbreviation = fold(team.abbreviation ?? '');
  if (abbreviation === query) return 0;
  const names = [team.displayName, team.name]
    .filter((name): name is string => name !== null)
    .map(fold);
  if (names.some((name) => name === query)) return 1;
  if (names.some((name) => name.startsWith(query))) return 2;
  if (names.some((name) => name.split(' ').some((word) => word.startsWith(query)))) return 3;
  if (names.some((name) => name.includes(query)) || abbreviation.startsWith(query)) return 4;
  return null;
}

export function rankMatches(teams: readonly TeamIdentity[], query: string): TeamIdentity[] {
  return teams
    .map((team) => ({ team, rank: score(team, query) }))
    .filter((entry): entry is { team: TeamIdentity; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.team.name.localeCompare(b.team.name))
    .slice(0, SEARCH_LIMIT)
    .map((entry) => entry.team);
}

export async function searchTeams(services: Services, query: string): Promise<TeamIdentity[]> {
  const { cache, provider } = services;
  const read = await cache.read<TeamIdentity[]>({
    key: cacheKey('team_list', provider.name),
    policyFor: () => policyFor('team_list'),
    load: () => provider.listTeams(),
  });
  const teams = read.envelope.data;
  if (teams === null) {
    // Search has nothing to show without the list, so this one is a real error.
    throw new HttpError(
      read.envelope.error?.kind ?? 'provider_unavailable',
      'Team search is temporarily unavailable.',
    );
  }
  return rankMatches(teams, query);
}
