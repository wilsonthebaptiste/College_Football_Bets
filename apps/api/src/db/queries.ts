import type { Team, UserSummary, UserTeamSelection } from '@cfb/shared';
import { notFound } from '../http/errors';
import type { PostgrestClient } from './postgrest';
import {
  countOf,
  toSelections,
  toTeam,
  type AppUserRow,
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
