import type { ProviderName, Team, TeamOwner, UserTeamSelection } from '@cfb/shared';
import { sizedLogoUrl, TEAM_LOGO_PX } from '../providers/logos';

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

/** A `user_team_selections` row as a write returns it (`Prefer: return=representation`). */
export interface SelectionIdRow {
  id: string;
  user_id: string;
  team_id: string;
  selection_order: number;
}

export interface UserWithSelectionsRow extends AppUserRow {
  user_team_selections: SelectionRow[] | null;
}

/**
 * A selection read from the other end: whose board it is on, and which team.
 * Both sides are embedded to-one relationships, so both may be `null` (plan
 * Part Two, Phase 5).
 */
export interface OwnerSelectionRow {
  app_users: Pick<AppUserRow, 'id' | 'display_name'> | null;
  teams: Pick<TeamRow, 'provider' | 'provider_team_id'> | null;
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

/**
 * The stored logo URL stays canonical (the provider's full-size image); what
 * leaves the API is a copy sized for the page (plan §5.3, `providers/logos.ts`).
 */
export function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    provider: toProviderName(row.provider),
    providerTeamId: row.provider_team_id,
    name: row.name,
    displayName: row.display_name,
    abbreviation: row.abbreviation,
    logoUrl: sizedLogoUrl(row.logo_url, TEAM_LOGO_PX),
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

/**
 * Every board's picks, inverted to provider team id → who has that team.
 *
 * Three rows are dropped rather than guessed at, on `toSelections`' principle
 * that half an answer is worse than none:
 *
 * - a row whose `app_users` or `teams` embed is `null` — impossible under
 *   `on delete restrict` and `on delete cascade`, but a name with no team or a
 *   team with no name is not something to render;
 * - a row whose team belongs to another provider's id namespace, because the
 *   key of this map is a provider id and ids from two namespaces do not
 *   compare (§43).
 *
 * Each list is sorted here, not by PostgREST: ordering by an embedded column
 * is a query-syntax feature whose support varies by version, and the sort is
 * free on 54 rows. `displayName` then `userId`, so two people with the same
 * name still come back in a stable order.
 *
 * A team nobody picked is simply absent. There is no de-duplication to do:
 * `unique (user_id, team_id)` means one row per person per team.
 */
export function toTeamOwners(
  rows: OwnerSelectionRow[],
  namespace: ProviderName,
): Record<string, TeamOwner[]> {
  const owners: Record<string, TeamOwner[]> = {};

  for (const row of rows) {
    const user = row.app_users;
    const team = row.teams;
    if (user === null || team === null) continue;
    if (toProviderName(team.provider) !== namespace) continue;

    const list = owners[team.provider_team_id] ?? [];
    list.push({ userId: user.id, displayName: user.display_name });
    owners[team.provider_team_id] = list;
  }

  for (const list of Object.values(owners)) {
    list.sort(
      (a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId),
    );
  }

  return owners;
}
