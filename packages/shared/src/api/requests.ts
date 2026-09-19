import type { TeamIdentity, UserTeamSelection } from '../domain';

/**
 * Request bodies for `/api/admin/*` (§8).
 *
 * Every one of these routes requires `Authorization: Bearer <supabase access
 * token>` from an account present in the `admins` table. The Worker returns 401
 * without a token and 403 with a non-admin one — and behind that, RLS refuses
 * the write anyway (§30, §31). The Worker check is a better error message; the
 * database is the boundary.
 */

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

// POST /api/admin/users
export interface CreateUserRequest {
  displayName: string;
}

export interface CreateUserResponse {
  user: { id: string; displayName: string };
}

// PATCH /api/admin/users/:userId
export interface RenameUserRequest {
  displayName: string;
}

// POST /api/admin/users/:userId/selections
/** §43 — selections reference a provider identity, never free-form text. */
export interface AddSelectionRequest {
  providerTeamId: string;
}

export interface AddSelectionResponse {
  selection: UserTeamSelection;
}

// PUT /api/admin/users/:userId/selections/order
/** §44 — the complete ordered list of selection ids, applied in one transaction. */
export interface ReorderSelectionsRequest {
  orderedIds: string[];
}

// GET /api/admin/teams/search?q=
export interface TeamSearchResponse {
  teams: TeamIdentity[];
}
