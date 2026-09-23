import type { TeamIdentity, UserSummary, UserTeamSelection } from '../domain';

/**
 * Request and response bodies for `/api/admin/*` (§8).
 *
 * Every one of these routes requires `Authorization: Bearer <supabase access
 * token>` from an account present in the `admins` table. The Worker returns 401
 * without a token and 403 with a non-admin one — and behind that, RLS refuses
 * the write anyway (§30, §31). The Worker check is a better error message; the
 * database is the boundary.
 *
 * Admin responses are sent `private, no-store`: they are what the administrator
 * just changed, and must never come out of a cache.
 */

/**
 * §13 — a board shows six teams. A presentation convention, not a rule: the
 * schema allows up to `MAX_SELECTIONS` (§52 headroom), and the admin console
 * warns, rather than refuses, past six.
 */
export const BOARD_TEAM_COUNT = 6;

/** Mirrors the CHECK on `user_team_selections.selection_order` (1–24). The database enforces it. */
export const MAX_SELECTIONS = 24;

/** Mirrors the CHECK on `app_users.display_name`. The database enforces it. */
export const DISPLAY_NAME_MAX_LENGTH = 60;

// GET /api/admin/session
/**
 * The Worker's answer to "is this session an administrator?". The web app's
 * `RequireAdmin` asks it so a signed-in stranger sees "not an administrator"
 * rather than a console whose every action fails. That makes the UI honest; it
 * does not make it the boundary. RLS still refuses the write (§30, §31).
 */
export interface AdminSessionResponse {
  admin: { authUserId: string };
}

// GET /api/admin/users
/** The public list's shape, read with the administrator's token and never cached. */
export interface AdminUsersResponse {
  users: UserSummary[];
}

// POST /api/admin/users
export interface CreateUserRequest {
  displayName: string;
}

export interface CreateUserResponse {
  user: { id: string; displayName: string };
}

// GET /api/admin/users/:userId
/** One board's identity and ordered selections, uncached, for the board editor. */
export interface AdminBoardResponse {
  user: { id: string; displayName: string };
  selections: UserTeamSelection[];
}

// PATCH /api/admin/users/:userId
export interface RenameUserRequest {
  displayName: string;
}

export interface RenameUserResponse {
  user: { id: string; displayName: string };
}

// DELETE /api/admin/users/:userId → 204. The board's selections go with it
// (`on delete cascade`); the teams stay, because other boards may hold them.

// POST /api/admin/users/:userId/selections
/** §43 — selections reference a provider identity, never free-form text. */
export interface AddSelectionRequest {
  providerTeamId: string;
}

/**
 * Every selection write answers with the board as it now stands, numbered
 * 1…n, so the editor never has to guess what the server did.
 */
export interface SelectionsResponse {
  userId: string;
  selections: UserTeamSelection[];
}

export interface AddSelectionResponse extends SelectionsResponse {
  /** The selection just created. */
  selection: UserTeamSelection;
}

// DELETE /api/admin/selections/:selectionId → SelectionsResponse

// PUT /api/admin/users/:userId/selections/order → SelectionsResponse
/**
 * §44 — the complete ordered list of the board's selection ids, applied in one
 * transaction. A list that is not exactly the board's current set is a 409: the
 * board changed since the editor loaded it.
 */
export interface ReorderSelectionsRequest {
  orderedIds: string[];
}

/**
 * GET /api/admin/teams/search?q= — and, since the search engine's Phase 2, the
 * public GET /api/search/teams?q= as well. The two routes return exactly this,
 * ranked by the same code; they differ only in who may ask and in whether the
 * answer may be cached. The shape is the odd one out in this file, which is
 * otherwise admin-only.
 */
export interface TeamSearchResponse {
  teams: TeamIdentity[];
}
