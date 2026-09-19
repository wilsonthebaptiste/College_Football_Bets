import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { ErrorState, LoadingNote } from '../components/States';
import { isApiError } from '../lib/apiClient';
import { useAdminSession } from './AdminSessionProvider';
import { useAdminCheck } from './useAdminCheck';

/**
 * Guards `/admin` and the pages under it, and nothing else (plan §9). Two
 * checks, both UX:
 *
 * 1. A session exists. Without one, go to `/login` and come back afterwards.
 * 2. The Worker agrees this session is an administrator. A valid login that
 *    is not in `admins` gets a plain "not an administrator" page instead of a
 *    console whose every action would fail.
 *
 * Neither is the security boundary. Hiding this page protects nothing; the
 * database refuses the writes on its own (§30, §31).
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const session = useAdminSession();
  const location = useLocation();

  const check = useAdminCheck();

  if (!session.configured) {
    return (
      <ErrorState
        title="Admin sign-in isn't set up"
        message="This build has no Supabase settings. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to apps/web/.env, then restart the dev server."
      />
    );
  }

  if (session.status === 'checking') return <LoadingNote>Checking your session…</LoadingNote>;

  if (session.status === 'signed-out') {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }

  if (check.isPending) return <LoadingNote>Checking administrator access…</LoadingNote>;

  if (check.isError) {
    const error = check.error;
    if (isApiError(error) && error.kind === 'forbidden') {
      return (
        <ErrorState
          title="Not an administrator"
          message={`${session.email ?? 'This account'} is signed in, but it isn't an administrator. Sign out and use the administrator account.`}
          action={
            <button type="button" className="button" onClick={() => void session.signOut()}>
              Sign out
            </button>
          }
        />
      );
    }
    return (
      <ErrorState
        title="Couldn't confirm administrator access"
        message={error.message}
        requestId={isApiError(error) ? error.requestId : null}
        action={
          <button type="button" className="button" onClick={() => void check.refetch()}>
            Try again
          </button>
        }
      />
    );
  }

  return children;
}
