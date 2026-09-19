import type {
  AddSelectionResponse,
  AdminBoardResponse,
  AdminSessionResponse,
  AdminUsersResponse,
  BoardResponse,
  CreateUserResponse,
  PredictionResponse,
  RenameUserResponse,
  SelectionsResponse,
  TeamDetailResponse,
  TeamScheduleResponse,
  TeamSearchResponse,
  UsersResponse,
} from '@cfb/shared';
import { getPublic, requestAdmin, type AdminAuthHooks } from './apiClient';

const id = (value: string): string => encodeURIComponent(value);

/** The API routes the web app calls, typed by the shared contract (plan §8). */
export const api = {
  users: (signal?: AbortSignal) => getPublic<UsersResponse>('/api/users', signal),

  board: (userId: string, signal?: AbortSignal) =>
    getPublic<BoardResponse>(`/api/users/${id(userId)}/board`, signal),

  team: (teamId: string, signal?: AbortSignal) =>
    getPublic<TeamDetailResponse>(`/api/teams/${id(teamId)}`, signal),

  schedule: (teamId: string, signal?: AbortSignal) =>
    getPublic<TeamScheduleResponse>(`/api/teams/${id(teamId)}/schedule`, signal),

  prediction: (providerGameId: string, signal?: AbortSignal) =>
    getPublic<PredictionResponse>(`/api/games/${id(providerGameId)}/prediction`, signal),

  /**
   * "Is this session an administrator?" Asked by `RequireAdmin` and by the
   * header's Admin link. A dead session is cleared without a redirect: the
   * guard sends the admin to sign in by itself, and the header must not.
   */
  adminSession: (auth: AdminAuthHooks | null, signal?: AbortSignal) =>
    requestAdmin<AdminSessionResponse>(auth, '/api/admin/session', {
      redirectOnUnauthorized: false,
      ...(signal ? { signal } : {}),
    }),
};

/**
 * The admin console's calls (plan §5.1). Every one needs the admin session's
 * auth hooks; the server answers 401/403 without them, and RLS refuses the
 * write regardless (§30, §31).
 */
export const adminApi = {
  users: (auth: AdminAuthHooks | null, signal?: AbortSignal) =>
    requestAdmin<AdminUsersResponse>(auth, '/api/admin/users', signal ? { signal } : {}),

  board: (auth: AdminAuthHooks | null, userId: string, signal?: AbortSignal) =>
    requestAdmin<AdminBoardResponse>(
      auth,
      `/api/admin/users/${id(userId)}`,
      signal ? { signal } : {},
    ),

  createUser: (auth: AdminAuthHooks | null, displayName: string) =>
    requestAdmin<CreateUserResponse>(auth, '/api/admin/users', {
      method: 'POST',
      body: { displayName },
    }),

  renameUser: (auth: AdminAuthHooks | null, userId: string, displayName: string) =>
    requestAdmin<RenameUserResponse>(auth, `/api/admin/users/${id(userId)}`, {
      method: 'PATCH',
      body: { displayName },
    }),

  deleteUser: (auth: AdminAuthHooks | null, userId: string) =>
    requestAdmin<undefined>(auth, `/api/admin/users/${id(userId)}`, { method: 'DELETE' }),

  addSelection: (auth: AdminAuthHooks | null, userId: string, providerTeamId: string) =>
    requestAdmin<AddSelectionResponse>(auth, `/api/admin/users/${id(userId)}/selections`, {
      method: 'POST',
      body: { providerTeamId },
    }),

  removeSelection: (auth: AdminAuthHooks | null, selectionId: string) =>
    requestAdmin<SelectionsResponse>(auth, `/api/admin/selections/${id(selectionId)}`, {
      method: 'DELETE',
    }),

  reorder: (auth: AdminAuthHooks | null, userId: string, orderedIds: readonly string[]) =>
    requestAdmin<SelectionsResponse>(auth, `/api/admin/users/${id(userId)}/selections/order`, {
      method: 'PUT',
      body: { orderedIds },
    }),

  searchTeams: (auth: AdminAuthHooks | null, query: string, signal?: AbortSignal) =>
    requestAdmin<TeamSearchResponse>(
      auth,
      `/api/admin/teams/search?q=${encodeURIComponent(query)}`,
      signal ? { signal } : {},
    ),
};

/** The public reads an admin change can make stale: primed after every write (`refreshPublic`). */
export const publicPathsFor = (userId: string): string[] => [
  '/api/users',
  `/api/users/${id(userId)}`,
  `/api/users/${id(userId)}/board`,
];

/**
 * Query keys in one place, so a board and its team pages can find each other's
 * data. Every admin key starts with `'admin'`: signing out clears that prefix.
 */
export const queryKeys = {
  users: ['users'] as const,
  boards: ['board'] as const,
  board: (userId: string) => ['board', userId] as const,
  team: (teamId: string) => ['team', teamId] as const,
  schedule: (teamId: string) => ['team', teamId, 'schedule'] as const,
  prediction: (providerGameId: string) => ['prediction', providerGameId] as const,
  adminSession: ['admin', 'session'] as const,
  adminUsers: ['admin', 'users'] as const,
  adminBoard: (userId: string) => ['admin', 'board', userId] as const,
  adminSearch: (query: string) => ['admin', 'search', query] as const,
};
