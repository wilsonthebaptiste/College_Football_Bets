import type { TeamIdentity } from '@cfb/shared';
import { cacheKey, policyFor } from '../cache/policy';
import { HttpError, invalidRequest } from '../http/errors';
import { sizedLogoUrl, TEAM_LOGO_PX } from '../providers/logos';
import type { ConferenceMap } from '../providers/types';
import { resolveSeason } from '../season/resolve';
import type { Services } from './context';

/**
 * Team search (§43): the provider's full team list, fetched once and cached for
 * 24 hours, filtered here. 762 teams is a list, not a search engine. Each
 * result carries its conference (plan §5.1), from a second cached read.
 *
 * Three callers now, and nothing here belongs to any one of them: the admin
 * console's own search, the public `/api/search/teams`, and — through
 * `findTeamIdentity` — a team page for a team nobody has put on a board. Any
 * message that reaches a viewer is worded for all three (see `readTeamList`).
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

/** The provider's full team list, through the cache (24 h). */
export async function readTeamList(services: Services): Promise<TeamIdentity[]> {
  const { cache, provider } = services;
  const read = await cache.read<TeamIdentity[]>({
    key: cacheKey('team_list', provider.name),
    policyFor: () => policyFor('team_list'),
    load: () => provider.listTeams(),
  });
  const teams = read.envelope.data;
  if (teams === null) {
    // Nothing downstream has anything to show without the list, so unlike most
    // provider failures this one is a real error rather than an envelope.
    //
    // The wording is deliberately not "team search": since Phase 1 this also
    // backs `/api/teams/:providerTeamId`, and the message reaches the viewer
    // verbatim (`TeamPage` renders `error.message`). A team page must not
    // announce that a search failed.
    throw new HttpError(
      read.envelope.error?.kind ?? 'provider_unavailable',
      'Team information is temporarily unavailable.',
    );
  }
  return teams;
}

/**
 * Conference names for the current season (espn-notes §7), through the cache
 * (24 h). Optional garnish: if they cannot be loaded, teams are listed without
 * a conference rather than not at all.
 */
export async function readConferences(services: Services): Promise<ConferenceMap> {
  const { cache, provider } = services;
  const { season } = await resolveSeason(services);
  const read = await cache.read<ConferenceMap>({
    key: cacheKey('conferences', provider.name, String(season.year)),
    policyFor: () => policyFor('conferences'),
    load: () => provider.getConferences(season),
  });
  return read.envelope.data ?? {};
}

function withConference(team: TeamIdentity, conferences: ConferenceMap): TeamIdentity {
  return team.conference !== null
    ? team
    : { ...team, conference: conferences[team.providerTeamId] ?? null };
}

export async function searchTeams(services: Services, query: string): Promise<TeamIdentity[]> {
  const [teams, conferences] = await Promise.all([
    readTeamList(services),
    readConferences(services),
  ]);
  return rankMatches(teams, query).map((team) => ({
    ...withConference(team, conferences),
    // Shown at 40 px in the results list; the stored URL stays canonical.
    logoUrl: sizedLogoUrl(team.logoUrl, TEAM_LOGO_PX),
  }));
}

/**
 * One team's identity, as the provider lists it, with its conference: what a
 * new `teams` row is made from when the administrator adds it to a board
 * (§43). The logo URL is the canonical one, so the row stores that. `null`
 * when the provider lists no such team.
 */
export async function findTeamIdentity(
  services: Services,
  providerTeamId: string,
): Promise<TeamIdentity | null> {
  const teams = await readTeamList(services);
  const team = teams.find((candidate) => candidate.providerTeamId === providerTeamId);
  if (team === undefined) return null;
  return withConference(team, await readConferences(services));
}
