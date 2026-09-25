import type {
  ProviderName,
  Team,
  TeamIdentity,
  TeamOwner,
  UserSummary,
  UserTeamSelection,
} from '@cfb/shared';
import { notFound } from '../http/errors';
import type { PostgrestClient } from './postgrest';
import {
  countOf,
  toSelections,
  toTeam,
  toTeamOwners,
  type AppUserRow,
  type OwnerSelectionRow,
  type SelectionIdRow,
  type TeamRow,
  type UserSummaryRow,
  type UserWithSelectionsRow,
} from './rows';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rejected before it reaches PostgREST, so a bad path segment is a clean 404. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

const TEAM_COLUMNS =
  'id,provider,provider_team_id,name,display_name,abbreviation,logo_url,conference,primary_color,alt_color';

/** §15 — the home screen: nine names and how many teams each board holds. */
export async function listUsers(db: PostgrestClient): Promise<UserSummary[]> {
  const rows = await db.select<UserSummaryRow>('app_users', {
    select: 'id,display_name,user_team_selections(count)',
    order: 'display_name.asc',
  });

  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    teamCount: countOf(row.user_team_selections),
  }));
}

export interface UserWithSelections {
  user: { id: string; displayName: string };
  selections: UserTeamSelection[];
}

/**
 * Identity only — no records, ranks, or scores (§45). The board route adds the
 * provider-owned half on top of this.
 */
export async function getUserWithSelections(
  db: PostgrestClient,
  userId: string,
): Promise<UserWithSelections> {
  if (!isUuid(userId)) throw notFound('No such user.');

  const rows = await db.select<UserWithSelectionsRow>('app_users', {
    select: `id,display_name,user_team_selections(id,selection_order,created_at,teams(${TEAM_COLUMNS}))`,
    id: `eq.${userId}`,
    // PostgREST orders an embedded resource with `<relation>.order`.
    'user_team_selections.order': 'selection_order.asc',
    limit: '1',
  });

  const row = rows[0];
  if (row === undefined) throw notFound('No such user.');

  return {
    user: { id: row.id, displayName: row.display_name },
    selections: toSelections(row.user_team_selections ?? []),
  };
}

/**
 * Who has each team, across every board (plan Part Two, Phase 5).
 *
 * One `select` with no filters: nine boards of six is 54 rows, and the schema's
 * ceiling of 24 per board puts these nine at 216 — well inside any PostgREST
 * row cap. Past roughly 150 boards this would need a limit, and that is a
 * different plan.
 *
 * Identity only (§45), and no `order` parameter: the sort is an embedded
 * column, which `toTeamOwners` does in memory for the reason recorded there.
 */
export async function listTeamOwners(
  db: PostgrestClient,
  namespace: ProviderName,
): Promise<Record<string, TeamOwner[]>> {
  const rows = await db.select<OwnerSelectionRow>('user_team_selections', {
    select: 'app_users(id,display_name),teams(provider,provider_team_id)',
  });
  return toTeamOwners(rows, namespace);
}

/**
 * One team's identity (§16). A team is global, not board-owned, so its page is
 * keyed by our own uuid and needs no board context (plan §3).
 */
export async function getTeamById(db: PostgrestClient, teamId: string): Promise<Team> {
  if (!isUuid(teamId)) throw notFound('No such team.');

  const rows = await db.select<TeamRow>('teams', {
    select: TEAM_COLUMNS,
    id: `eq.${teamId}`,
    limit: '1',
  });

  const row = rows[0];
  if (row === undefined) throw notFound('No such team.');
  return toTeam(row);
}

/** Admin write. Refused by RLS unless the caller's token belongs to an admin. */
export async function createUser(
  db: PostgrestClient,
  displayName: string,
): Promise<{ id: string; displayName: string }> {
  const row = await db.insertOne<AppUserRow>('app_users', { display_name: displayName });
  return { id: row.id, displayName: row.display_name };
}

// ─── Admin writes (Phase 5) ──────────────────────────────────────────────────
// Every function below takes the administrator's client (`supabaseAsAdmin`).
// Given any other client, Postgres refuses the write: that is the boundary
// (§30, §31), and nothing here re-checks it.

/** 404 when there is no such user. An UPDATE that RLS hides looks the same, and is refused anyway. */
export async function renameUser(
  db: PostgrestClient,
  userId: string,
  displayName: string,
): Promise<{ id: string; displayName: string }> {
  if (!isUuid(userId)) throw notFound('No such user.');
  const rows = await db.update<AppUserRow>(
    'app_users',
    { id: `eq.${userId}` },
    { display_name: displayName },
  );
  const row = rows[0];
  if (row === undefined) throw notFound('No such user.');
  return { id: row.id, displayName: row.display_name };
}

/** Removes the user and, by `on delete cascade`, their board. Teams stay. */
export async function deleteUser(db: PostgrestClient, userId: string): Promise<void> {
  if (!isUuid(userId)) throw notFound('No such user.');
  const rows = await db.remove<AppUserRow>('app_users', { id: `eq.${userId}` });
  if (rows.length === 0) throw notFound('No such user.');
}

/** The stored team for a provider identity (§43), or `null` if none is stored yet. */
export async function findTeamByProviderId(
  db: PostgrestClient,
  provider: ProviderName,
  providerTeamId: string,
): Promise<Team | null> {
  const rows = await db.select<TeamRow>('teams', {
    select: TEAM_COLUMNS,
    provider: `eq.${provider}`,
    provider_team_id: `eq.${providerTeamId}`,
    limit: '1',
  });
  const row = rows[0];
  return row === undefined ? null : toTeam(row);
}

/** Stores a provider identity as a `teams` row (§43). Identity only, never records or ranks (§45). */
export async function insertTeam(
  db: PostgrestClient,
  provider: ProviderName,
  identity: TeamIdentity,
): Promise<Team> {
  const row = await db.insertOne<TeamRow>('teams', {
    provider,
    provider_team_id: identity.providerTeamId,
    name: identity.name,
    display_name: identity.displayName,
    abbreviation: identity.abbreviation,
    logo_url: identity.logoUrl,
    conference: identity.conference,
    primary_color: identity.primaryColor,
    alt_color: identity.altColor,
  });
  return toTeam(row);
}

export async function insertSelection(
  db: PostgrestClient,
  userId: string,
  teamId: string,
  order: number,
): Promise<string> {
  const row = await db.insertOne<SelectionIdRow>('user_team_selections', {
    user_id: userId,
    team_id: teamId,
    selection_order: order,
  });
  return row.id;
}

/** Deletes one selection and says whose board it was on. 404 when there is no such selection. */
export async function deleteSelection(
  db: PostgrestClient,
  selectionId: string,
): Promise<{ userId: string }> {
  if (!isUuid(selectionId)) throw notFound('No such selection.');
  const rows = await db.remove<SelectionIdRow>('user_team_selections', {
    id: `eq.${selectionId}`,
  });
  const row = rows[0];
  if (row === undefined) throw notFound('No such selection.');
  return { userId: row.user_id };
}

/**
 * §44 — one call, one transaction: `reorder_selections` renumbers the whole
 * board 1…n in the order given. Raises 42501 for a non-administrator (→ 403)
 * and 22023 for an id from another board (→ 400).
 */
export async function reorderSelections(
  db: PostgrestClient,
  userId: string,
  orderedIds: readonly string[],
): Promise<void> {
  await db.rpc<null>('reorder_selections', { p_user_id: userId, p_ordered_ids: orderedIds });
}

/**
 * Asks the database whether the caller is an administrator.
 *
 * `is_admin()` is `security definer` so it can read the `admins` table, which
 * deliberately has no RLS policies and is therefore invisible to the API (§4).
 */
export async function callIsAdmin(db: PostgrestClient): Promise<boolean> {
  const result = await db.rpc<unknown>('is_admin');
  return result === true;
}
