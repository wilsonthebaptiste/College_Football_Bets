import type {
  AdminSessionResponse,
  BoardResponse,
  TeamDetailResponse,
  UsersResponse,
} from '@cfb/shared';
import { getPublic, requestAdmin, type AdminAuthHooks } from './apiClient';

/** The API routes the web app calls, typed by the shared contract (plan §8). */
export const api = {
  users: (signal?: AbortSignal) => getPublic<UsersResponse>('/api/users', signal),

  board: (userId: string, signal?: AbortSignal) =>
    getPublic<BoardResponse>(`/api/users/${encodeURIComponent(userId)}/board`, signal),

  team: (teamId: string, signal?: AbortSignal) =>
    getPublic<TeamDetailResponse>(`/api/teams/${encodeURIComponent(teamId)}`, signal),

  adminSession: (auth: AdminAuthHooks | null, signal?: AbortSignal) =>
    requestAdmin<AdminSessionResponse>(auth, '/api/admin/session', signal ? { signal } : {}),
};

/** Query keys in one place, so a board and its team pages can find each other's data. */
export const queryKeys = {
  users: ['users'] as const,
  boards: ['board'] as const,
  board: (userId: string) => ['board', userId] as const,
  team: (teamId: string) => ['team', teamId] as const,
  adminSession: ['admin', 'session'] as const,
};
