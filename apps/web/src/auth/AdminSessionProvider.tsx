import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router';
import type { AdminAuthHooks } from '../lib/apiClient';
import { SUPABASE_CONFIG } from '../lib/config';
import { hasStoredAdminSession, loadAdminAuth, type AdminAuthClient } from './adminAuth';

/**
 * The admin session (§29: login, logout, persistent sessions).
 *
 * Viewers are never signed in and never will be (plan §11.1), so for them this
 * provider is inert: status `signed-out`, no auth library loaded, no network.
 * It wakes up only when this browser has a stored admin session, or when
 * someone opens `/login` or `/admin`.
 *
 * Everything here is UX. The database decides who may write (§30, §31).
 */

export type AdminStatus = 'signed-out' | 'checking' | 'signed-in';

export interface AdminSession {
  status: AdminStatus;
  email: string | null;
  /** False when the build has no Supabase settings; sign-in cannot work at all. */
  configured: boolean;
  /** For admin API calls. Non-null exactly while signed in. */
  authHooks: AdminAuthHooks | null;
  /** Loads the auth client ahead of use (the sign-in page does, so submitting is instant). */
  prepare: () => Promise<void>;
  /** `null` on success, otherwise a message for the form. */
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AdminSessionContext = createContext<AdminSession | null>(null);

interface SessionState {
  status: AdminStatus;
  email: string | null;
}

const SIGNED_OUT: SessionState = { status: 'signed-out', email: null };

export function AdminSessionProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const configured = SUPABASE_CONFIG !== null;

  // Decided once, from localStorage only. A viewer's browser answers "no" and
  // this provider never loads anything.
  const [restore] = useState(() => configured && hasStoredAdminSession());
  const [session, setSession] = useState<SessionState>(() =>
    restore ? { status: 'checking', email: null } : SIGNED_OUT,
  );
  const [client, setClient] = useState<AdminAuthClient | null>(null);

  const load = useCallback(async (): Promise<AdminAuthClient> => {
    const loaded = await loadAdminAuth();
    setClient(loaded);
    return loaded;
  }, []);

  useEffect(() => {
    if (!restore) return;
    load().catch(() => setSession(SIGNED_OUT));
  }, [restore, load]);

  useEffect(() => {
    if (client === null) return;
    return client.subscribe((info) => {
      setSession(info === null ? SIGNED_OUT : { status: 'signed-in', email: info.email });
    });
  }, [client]);

  const authHooks = useMemo<AdminAuthHooks | null>(() => {
    if (client === null || session.status !== 'signed-in') return null;
    return {
      getAccessToken: () => client.accessToken(),
      refresh: () => client.refresh(),
      onUnauthorized: () => {
        void client.signOut();
        queryClient.removeQueries({ queryKey: ['admin'] });
        const next = `${window.location.pathname}${window.location.search}`;
        void navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
      },
    };
  }, [client, session.status, navigate, queryClient]);

  const prepare = useCallback(async () => {
    await load();
  }, [load]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      let loaded: AdminAuthClient;
      try {
        loaded = await load();
      } catch {
        return 'Admin sign-in could not be loaded. Check your connection and try again.';
      }
      return loaded.signIn(email, password);
    },
    [load],
  );

  const signOut = useCallback(async () => {
    if (client !== null) await client.signOut();
    queryClient.removeQueries({ queryKey: ['admin'] });
    setSession(SIGNED_OUT);
  }, [client, queryClient]);

  const value = useMemo<AdminSession>(
    () => ({
      status: session.status,
      email: session.email,
      configured,
      authHooks,
      prepare,
      signIn,
      signOut,
    }),
    [session, configured, authHooks, prepare, signIn, signOut],
  );

  return <AdminSessionContext.Provider value={value}>{children}</AdminSessionContext.Provider>;
}

export function useAdminSession(): AdminSession {
  const value = useContext(AdminSessionContext);
  if (value === null) throw new Error('useAdminSession must be used inside AdminSessionProvider.');
  return value;
}
