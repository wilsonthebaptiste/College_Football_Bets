import type { ProviderName, Team, UserTeamSelection } from '@cfb/shared';

/**
 * Postgres row shapes, kept separate from the domain model on the same principle
 * as `providers/espn/raw.ts` (§41): the wire shape and the application shape are
 * different things, and mapping between them is a function you can test.
 */

export interface AppUserRow {
  id: string;
  display_name: string;
  created_at?: string;
  updated_at?: string;
}

export interface TeamRow {
  id: string;
  provider: string;
  provider_team_id: string;
  name: string;
  display_name: string | null;
  abbreviation: string | null;
  logo_url: string | null;
  conference: string | null;
  primary_color: string | null;
  alt_color: string | null;
}

export interface SelectionRow {
  id: string;
  selection_order: number;
  created_at: string;
  /** PostgREST embeds a to-one relationship as an object (or null). */
  teams: TeamRow | null;
}

export interface UserWithSelectionsRow extends AppUserRow {
  user_team_selections: SelectionRow[] | null;
}

/** PostgREST renders `select=...,child(count)` as `[{ count: n }]`. */
export interface CountAggregate {
  count: number;
}

export interface UserSummaryRow extends AppUserRow {
  user_team_selections: CountAggregate[] | null;
}

function toProviderName(value: string): ProviderName {
  return value === 'mock' ? 'mock' : 'espn';
}

export function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    provider: toProviderName(row.provider),
    providerTeamId: row.provider_team_id,
    name: row.name,
    displayName: row.display_name,
    abbreviation: row.abbreviation,
    logoUrl: row.logo_url,
    conference: row.conference,
    primaryColor: row.primary_color,
    altColor: row.alt_color,
  };
}

/**
 * Drops selections whose team failed to embed. That can only happen if a row is
 * orphaned, which `on delete restrict` is supposed to prevent — but rendering a
 * card with no team is worse than rendering five cards (§42).
 */
export function toSelections(rows: SelectionRow[]): UserTeamSelection[] {
  const selections: UserTeamSelection[] = [];
  for (const row of rows) {
    if (row.teams === null) continue;
    selections.push({
      id: row.id,
      order: row.selection_order,
      team: toTeam(row.teams),
      createdAt: row.created_at,
    });
  }
  // §44 — the administrator's order is the presentation order. Sort defensively
  // in case an embedded-order query param is ever dropped from a query.
  return selections.sort((a, b) => a.order - b.order);
}

export function countOf(aggregate: CountAggregate[] | null): number {
  return aggregate?.[0]?.count ?? 0;
}
