import { useQuery } from '@tanstack/react-query';
import { api, queryKeys } from '../lib/api';
import { useAdminSession } from './AdminSessionProvider';

/** The Worker's answer is per session and changes only on sign-in or sign-out. */
const CHECK_STALE_MS = 5 * 60_000;

/**
 * Asks the Worker whether the signed-in account is an administrator
 * (`GET /api/admin/session`). One query, shared by `RequireAdmin` and the
 * header's Admin link, so asking twice costs one request.
 *
 * Idle for viewers: with no admin session there are no auth hooks, and the
 * query never runs.
 */
export function useAdminCheck() {
  const session = useAdminSession();
  return useQuery({
    queryKey: queryKeys.adminSession,
    queryFn: ({ signal }) => api.adminSession(session.authHooks, signal),
    enabled: session.authHooks !== null,
    staleTime: CHECK_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
