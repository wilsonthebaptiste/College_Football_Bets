import type { Team } from './team';

/**
 * A board participant (§3).
 *
 * There is deliberately no auth identity and no admin flag here. Viewers never
 * sign in (plan §11.1), so an `app_user` is purely a display profile that owns a
 * board; the only auth identities in the system live in the `admins` table.
 */
export interface AppUser {
  id: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserSummary {
  id: string;
  displayName: string;
  teamCount: number;
}

/** §44 — the order is the administrator's intent and must be preserved. */
export interface UserTeamSelection {
  id: string;
  order: number;
  team: Team;
  createdAt: string;
}
