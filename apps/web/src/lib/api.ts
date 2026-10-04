import type {
  AddSelectionResponse,
  AdminBoardResponse,
  AdminSessionResponse,
  AdminUsersResponse,
  BoardProjectionResponse,
  BoardResponse,
  CreateUserResponse,
  GameDetailResponse,
  MatchupBoardResponse,
  MatchupResponse,
  PredictionResponse,
  ProjectionsResponse,
  RenameUserResponse,
  SelectionsResponse,
  TeamDetailResponse,
  TeamOwnersResponse,
  TeamProjectionResponse,
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
   * Public team search (plan-search-engine, Phase 2). The same ranking the
   * admin console's own search uses, through the public door: no token, and a
   * five-minute `Cache-Control`, so backtracking over a prefix costs nothing.
   */
  searchTeams: (query: string, signal?: AbortSignal) =>
    getPublic<TeamSearchResponse>(`/api/search/teams?q=${encodeURIComponent(query)}`, signal),

  /**
   * Who has each team, by provider team id (plan-search-engine, Phase 5). One
   * read per page session, deliberately not a field on the search response:
   * that route is one keystroke away and is pinned to make no Postgres request
   * at all, which is what keeps typing free of Postgres latency and outages.
   */
  teamOwners: (signal?: AbortSignal) => getPublic<TeamOwnersResponse>('/api/selections', signal),

  /**
   * Projected points (predicting_score.md, Phase 4). Three reads, each its own
   * request and never a field on the board or the team (§42): a scrape that
   * fails must cost the page it sits on nothing.
   */
  projections: (signal?: AbortSignal) => getPublic<ProjectionsResponse>('/api/projections', signal),

  boardProjection: (userId: string, signal?: AbortSignal) =>
    getPublic<BoardProjectionResponse>(`/api/users/${id(userId)}/projection`, signal),

  teamProjection: (teamId: string, signal?: AbortSignal) =>
    getPublic<TeamProjectionResponse>(`/api/teams/${id(teamId)}/projection`, signal),

  /**
   * The matchup board (plan-matchup-board, Phase 2): every game in a week
   * between two boards. `week` is the provider's own week number, exactly as
   * the response's `weeks[].week` gives it; `null` asks the server for the
   * current week, which it chooses (the client never guesses it).
   */
  matchups: (week: string | null, signal?: AbortSignal) =>
    getPublic<MatchupBoardResponse>(
      week === null ? '/api/matchups' : `/api/matchups?week=${encodeURIComponent(week)}`,
      signal,
    ),

  /** One game, in the same row shape, for any game the provider has. */
  matchup: (providerGameId: string, signal?: AbortSignal) =>
    getPublic<MatchupResponse>(`/api/matchups/${id(providerGameId)}`, signal),

  /**
   * Inside one game (plan-matchup-board, Phase 3): line score, stats, leaders,
   * scoring plays, drive, and the in-game win probability. Its own request, so
   * a failed box score leaves the game's header and its prediction (§42).
   */
  gameDetail: (providerGameId: string, signal?: AbortSignal) =>
    getPublic<GameDetailResponse>(`/api/games/${id(providerGameId)}/detail`, signal),

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

/**
 * The public reads that ANY admin change can make stale, whichever board it
 * touched: the people list, and the pick index, which carries display names as
 * well as memberships — so a rename changes it too. The projected leaderboard
 * is the same kind of read: it names everybody and totals every board, so a
 * rename, a new person, or any one board's change moves it. So is the current
 * week's matchup board, which names the owners of every side (other weeks and
 * single games are left to their own short lifetimes: at most a minute).
 */
export const PUBLIC_INDEX_PATHS: readonly string[] = [
  '/api/users',
  '/api/selections',
  '/api/projections',
  '/api/matchups',
];

/** The public reads an admin change can make stale: primed after every write (`refreshPublic`). */
export const publicPathsFor = (userId: string): string[] => [
  ...PUBLIC_INDEX_PATHS,
  `/api/users/${id(userId)}`,
  `/api/users/${id(userId)}/board`,
  `/api/users/${id(userId)}/projection`,
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
  /** Inside a game. Provider data, not picks, so outside the `'matchups'` prefix an admin write sweeps. */
  gameDetail: (providerGameId: string) => ['gameDetail', providerGameId] as const,
  /**
   * The public search. Deliberately NOT under the `'admin'` prefix: signing out
   * clears that prefix, and a viewer's search results are not the admin's.
   * `query` is already normalized by the caller (`trim().toLowerCase()`), so
   * "Texas" and "texas" are one entry and one request, not two.
   */
  search: (query: string) => ['search', query] as const,
  /**
   * The pick index. One key, not one per query: the whole index arrives in a
   * single answer and the browser joins it onto whatever is on screen, so
   * typing another letter cannot produce a second request. Out of the `'admin'`
   * prefix for the same reason `search` is — a viewer's index is not the
   * administrator's, and signing out sweeps that prefix.
   */
  owners: ['owners'] as const,
  /**
   * Projected points. All three share the `'projections'` prefix, so an admin
   * write can sweep every one of them with a single invalidation; and none is
   * under `'admin'`, for the reason `search` is not.
   */
  projections: ['projections'] as const,
  boardProjection: (userId: string) => ['projections', 'board', userId] as const,
  teamProjection: (teamId: string) => ['projections', 'team', teamId] as const,
  /**
   * The matchup board and its games. One prefix, so an admin write sweeps them
   * all with one invalidation; out of `'admin'` for the reason `search` is.
   * `week` is the URL's own `?week=` text, or `'current'` without one: the
   * server decides what the current week is, so "current" and "6" are two
   * entries even when they are the same week.
   */
  matchups: ['matchups'] as const,
  matchupBoard: (week: string | null) => ['matchups', 'week', week ?? 'current'] as const,
  matchup: (providerGameId: string) => ['matchups', 'game', providerGameId] as const,
  adminSession: ['admin', 'session'] as const,
  adminUsers: ['admin', 'users'] as const,
  adminBoard: (userId: string) => ['admin', 'board', userId] as const,
  adminSearch: (query: string) => ['admin', 'search', query] as const,
};
