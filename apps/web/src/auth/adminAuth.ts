import { SUPABASE_CONFIG } from '../lib/config';

/**
 * The administrator's session, and nobody else's (plan §11.1).
 *
 * `supabase-js` is loaded on demand by `loadAdminAuth()`, so it lands in its
 * own chunk that viewers never download. Whether to load it at all is decided
 * from localStorage alone: no stored session means no import, no client, and
 * no network call to Supabase Auth. That is what lets the home, board, and team
 * pages render in a fresh private window with zero auth traffic.
 */

/** Pinned rather than left to supabase-js's per-project default, so it can be checked without loading the library. */
export const ADMIN_SESSION_STORAGE_KEY = 'cfb-admin-session';

export interface AdminSessionInfo {
  email: string | null;
}

/** The slice of the auth client this app uses. Only `supabaseClient.ts` knows it is Supabase. */
export interface AdminAuthClient {
  /** Fires once with the current session, then on every change. Returns an unsubscribe. */
  subscribe(listener: (session: AdminSessionInfo | null) => void): () => void;
  accessToken(): Promise<string | null>;
  /** Forces a refresh. The new access token, or `null` if the session could not be renewed. */
  refresh(): Promise<string | null>;
  /** `null` on success, otherwise a message fit to show on the sign-in form. */
  signIn(email: string, password: string): Promise<string | null>;
  /** Ends the session on this device. */
  signOut(): Promise<void>;
}

export function hasStoredAdminSession(): boolean {
  try {
    return window.localStorage.getItem(ADMIN_SESSION_STORAGE_KEY) !== null;
  } catch {
    // Storage blocked (some private modes): there is no stored session to restore.
    return false;
  }
}

let pending: Promise<AdminAuthClient> | null = null;

export function loadAdminAuth(): Promise<AdminAuthClient> {
  const config = SUPABASE_CONFIG;
  if (config === null) return Promise.reject(new Error('Admin sign-in is not configured.'));

  if (pending === null) {
    const loading = import('./supabaseClient').then((module) =>
      module.createAdminAuthClient(config),
    );
    // A failed chunk load (offline) must not be cached forever.
    loading.catch(() => {
      pending = null;
    });
    pending = loading;
  }
  return pending;
}
