import type { ApiErrorBody, AppError, AppErrorKind } from '@cfb/shared';
import { apiUrl } from './config';

/**
 * The only way the browser talks to the Worker (§26). No ESPN URL, no ESPN
 * shape, and no Supabase table is ever reached from here.
 *
 * Two entry points, and the difference is deliberate:
 *
 * - `getPublic` never sends a token. Reads are public (plan §11.1), and a
 *   bearer token would add nothing but a CORS preflight and a response that
 *   caches differently.
 * - `requestAdmin` always sends one. On a 401 it refreshes the session once
 *   and retries; if that fails too, the session is cleared and the admin is
 *   sent to `/login`.
 *
 * Every failure becomes an `ApiError` carrying the server's `AppError`, so the
 * UI can tell provider trouble from a missing page from a lost session (§38).
 */

export class ApiError extends Error {
  readonly kind: AppErrorKind;
  /** The HTTP status, or `null` when no response arrived at all (offline, DNS, CORS). */
  readonly status: number | null;
  readonly requestId: string | null;

  constructor(error: AppError, status: number | null) {
    super(error.message);
    this.name = 'ApiError';
    this.kind = error.kind;
    this.status = status;
    this.requestId = error.requestId;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

const APP_ERROR_KINDS: readonly AppErrorKind[] = [
  'provider_unavailable',
  'provider_invalid_response',
  'invalid_request',
  'not_found',
  'unauthorized',
  'forbidden',
  'internal',
];

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error: unknown = value.error;
  if (typeof error !== 'object' || error === null) return false;
  const { kind, message } = error as Record<string, unknown>;
  return (
    typeof kind === 'string' &&
    (APP_ERROR_KINDS as readonly string[]).includes(kind) &&
    typeof message === 'string'
  );
}

/** For error responses without our JSON body: a proxy page, or the platform itself. */
export function kindForStatus(status: number): AppErrorKind {
  if (status === 400) return 'invalid_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 502) return 'provider_invalid_response';
  if (status === 503) return 'provider_unavailable';
  return 'internal';
}

const FALLBACK_MESSAGES: Record<AppErrorKind, string> = {
  provider_unavailable: 'Sports data temporarily unavailable.',
  provider_invalid_response: 'Sports data could not be read.',
  invalid_request: 'The request was not valid.',
  not_found: 'Not found.',
  unauthorized: 'Sign in to continue.',
  forbidden: 'This account does not have access.',
  internal: 'Something went wrong on the server.',
};

export const NETWORK_ERROR_MESSAGE =
  'Could not reach the server. Check your connection and try again.';

async function toApiError(response: Response): Promise<ApiError> {
  const requestId = response.headers.get('X-Request-Id');
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON. Fall through to a status-derived error.
  }
  if (isApiErrorBody(body)) {
    return new ApiError(
      { kind: body.error.kind, message: body.error.message, requestId: body.error.requestId },
      response.status,
    );
  }
  const kind = kindForStatus(response.status);
  return new ApiError({ kind, message: FALLBACK_MESSAGES[kind], requestId }, response.status);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(apiUrl(path), init);
  } catch (error) {
    // A cancelled query is not a failure; let the caller see the abort as is.
    if (isAbort(error)) throw error;
    throw new ApiError({ kind: 'internal', message: NETWORK_ERROR_MESSAGE, requestId: null }, null);
  }
}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) throw await toApiError(response);
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(
      {
        kind: 'internal',
        message: 'The server sent a response this page could not read.',
        requestId: response.headers.get('X-Request-Id'),
      },
      response.status,
    );
  }
}

/** A public read. Never carries a token. */
export async function getPublic<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await send(path, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: signal ?? null,
  });
  return parse<T>(response);
}

// ─── Admin requests ──────────────────────────────────────────────────────────

/**
 * Supplied by `AdminSessionProvider` while an admin session exists, and passed
 * to each admin call explicitly. There is no global token for a request to
 * pick up by accident.
 */
export interface AdminAuthHooks {
  /** The current access token, or `null` when there is no session. */
  getAccessToken(): Promise<string | null>;
  /** Refreshes the session once. The new token, or `null` if that failed. */
  refresh(): Promise<string | null>;
  /** The session is beyond saving: clear it and send the admin to sign in. */
  onUnauthorized(): void;
}

export interface AdminRequestInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

const SIGN_IN_REQUIRED: AppError = {
  kind: 'unauthorized',
  message: 'Sign in to continue.',
  requestId: null,
};

export async function requestAdmin<T>(
  auth: AdminAuthHooks | null,
  path: string,
  init: AdminRequestInit = {},
): Promise<T> {
  if (auth === null) throw new ApiError(SIGN_IN_REQUIRED, 401);

  const token = await auth.getAccessToken();
  if (token === null) {
    auth.onUnauthorized();
    throw new ApiError(SIGN_IN_REQUIRED, 401);
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  const attempt = (bearer: string): Promise<Response> =>
    send(path, {
      method: init.method ?? 'GET',
      headers: { ...headers, Authorization: `Bearer ${bearer}` },
      body: init.body === undefined ? null : JSON.stringify(init.body),
      signal: init.signal ?? null,
      // Admin answers are per-person and must never come out of a cache.
      cache: 'no-store',
    });

  let response = await attempt(token);
  if (response.status === 401) {
    // Most often an access token that expired while the tab slept. One refresh,
    // one retry; a second 401 means the session itself is gone.
    const refreshed = await auth.refresh();
    if (refreshed !== null) response = await attempt(refreshed);
    if (refreshed === null || response.status === 401) {
      auth.onUnauthorized();
      throw await toApiError(response);
    }
  }
  return parse<T>(response);
}
