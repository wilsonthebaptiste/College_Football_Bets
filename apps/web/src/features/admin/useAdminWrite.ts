import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { publicPathsFor, queryKeys } from '../../lib/api';
import { isApiError, refreshPublic } from '../../lib/apiClient';

/**
 * What every admin write does afterwards (plan §5.1: "the board reflects it on
 * reload"):
 *
 * 1. The console's own lists are refetched.
 * 2. The public reads the change touches are fetched again from the network,
 *    which replaces the browser's cached copies (`refreshPublic`). Without
 *    this, a board read inside its `max-age` would still show the old order.
 * 3. Only then are the viewer pages' queries invalidated, so their refetch
 *    finds the fresh copy.
 */
export function useAfterAdminWrite(): (userId: string | null) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (userId: string | null) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers });
      void refreshPublic(userId === null ? ['/api/users'] : publicPathsFor(userId)).then(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.users });
        if (userId !== null) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.board(userId) });
        }
      });
    },
    [queryClient],
  );
}

export interface Problem {
  message: string;
  requestId: string | null;
}

export function problemOf(error: unknown): Problem {
  return isApiError(error)
    ? { message: error.message, requestId: error.requestId }
    : { message: 'Something went wrong. Try again.', requestId: null };
}

/** Appended to repeat an announcement: a live region reads changes, not repeats. */
const NO_BREAK_SPACE = String.fromCharCode(0xa0);

/**
 * One polite live region per page, for what just happened ("Alabama added").
 * Changes made by button presses are otherwise silent to a screen reader.
 */
export function useAnnouncer(): [string, (message: string) => void] {
  const [message, setMessage] = useState('');
  const announce = useCallback((next: string) => {
    // The same sentence twice in a row (moving a team twice) must still be read.
    setMessage((previous) => (previous === next ? next + NO_BREAK_SPACE : next));
  }, []);
  return [message, announce];
}
