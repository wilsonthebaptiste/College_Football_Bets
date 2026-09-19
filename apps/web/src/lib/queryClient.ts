import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './apiClient';
import { POLL } from './poll';

/**
 * A 4xx will not change on retry (a missing board stays missing); a 5xx or a
 * dropped connection might. Two retries, then the error state takes over.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status !== null && error.status < 500) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: POLL.staleTimeMs,
        refetchOnWindowFocus: true,
        // §24: no background work while the tab is hidden. Focus resumes it.
        refetchIntervalInBackground: false,
        retry: shouldRetry,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      },
    },
  });
}
