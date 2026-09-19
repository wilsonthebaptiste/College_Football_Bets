import { createClient, type AuthError, type Session } from '@supabase/supabase-js';
import type { SupabaseConfig } from '../lib/config';
import {
  ADMIN_SESSION_STORAGE_KEY,
  type AdminAuthClient,
  type AdminSessionInfo,
} from './adminAuth';

/**
 * The only module that imports `supabase-js`. It is reached through a dynamic
 * `import()` in `adminAuth.ts`, which puts it in its own chunk.
 *
 * Used for the admin session and nothing else. Every read and write goes
 * through the Worker (§26); this client never touches a table.
 */

function toInfo(session: Session | null): AdminSessionInfo | null {
  return session === null ? null : { email: session.user.email ?? null };
}

function describeSignInError(error: AuthError): string {
  if (error.code === 'invalid_credentials' || error.status === 400) {
    return 'Email or password is incorrect.';
  }
  if (error.status === 429) return 'Too many attempts. Wait a minute, then try again.';
  if (
    error.status === undefined ||
    error.status === 0 ||
    error.name === 'AuthRetryableFetchError'
  ) {
    return 'Could not reach the sign-in service. Check your connection and try again.';
  }
  return error.message;
}

export function createAdminAuthClient(config: SupabaseConfig): AdminAuthClient {
  const client = createClient(config.url, config.anonKey, {
    auth: {
      storageKey: ADMIN_SESSION_STORAGE_KEY,
      persistSession: true, // §29: the session survives a reload
      autoRefreshToken: true,
      detectSessionInUrl: false, // password sign-in only; no magic links or OAuth redirects
    },
  });

  return {
    subscribe(listener) {
      // Supabase warns against awaiting its own calls inside this callback;
      // it only hands the state on.
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        listener(toInfo(session));
      });
      return () => data.subscription.unsubscribe();
    },

    async accessToken() {
      const { data } = await client.auth.getSession();
      return data.session?.access_token ?? null;
    },

    async refresh() {
      const { data, error } = await client.auth.refreshSession();
      return error === null ? (data.session?.access_token ?? null) : null;
    },

    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      return error === null ? null : describeSignInError(error);
    },

    async signOut() {
      // Local scope: signing out here leaves the admin's other devices signed in.
      await client.auth.signOut({ scope: 'local' });
    },
  };
}
