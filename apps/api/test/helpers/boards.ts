import { ROSTER } from '../../src/providers/mock/roster';

/**
 * Postgres rows shaped exactly as PostgREST returns them for the board and
 * team queries (`src/db/queries.ts`), built from the seeded roster.
 */

export const uuidFor = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const teamUuid = (providerTeamId: string): string => uuidFor(Number(providerTeamId));

export function teamRow(providerTeamId: string): Record<string, unknown> {
  const team = ROSTER.find((entry) => entry.id === providerTeamId);
  if (team === undefined) throw new Error(`no seeded team ${providerTeamId}`);
  return {
    id: teamUuid(providerTeamId),
    provider: 'espn',
    provider_team_id: team.id,
    name: team.name,
    display_name: team.short,
    abbreviation: team.abbr,
    logo_url: `https://example.test/logos/${team.id}.png`,
    conference: team.conference,
    primary_color: team.color,
    alt_color: team.alt,
  };
}

/** §56 — Wilson's board: Alabama, Georgia, Texas, Michigan, USC, LSU. */
export const WILSON_TEAMS = ['333', '61', '251', '130', '30', '99'];
/** Jordan shares Alabama and Texas with Wilson (seed.sql, the shared-team path in §27). */
export const JORDAN_TEAMS = ['333', '251', '194', '87', '235', '2655'];

export function userRow(
  index: number,
  displayName: string,
  providerTeamIds: string[],
): Record<string, unknown> {
  return {
    id: uuidFor(9000 + index),
    display_name: displayName,
    user_team_selections: providerTeamIds.map((providerTeamId, order) => ({
      id: uuidFor(5000 + index * 100 + order),
      selection_order: order + 1,
      created_at: '2026-09-01T00:00:00Z',
      teams: teamRow(providerTeamId),
    })),
  };
}

export const WILSON = userRow(1, 'Wilson', WILSON_TEAMS);
export const JORDAN = userRow(2, 'Jordan', JORDAN_TEAMS);
export const WILSON_ID = WILSON['id'] as string;
export const JORDAN_ID = JORDAN['id'] as string;

/** Every seeded team as a `teams` row, for the team routes. */
export const ALL_TEAM_ROWS = ROSTER.map((team) => teamRow(team.id));
