import type { UserSummary } from '@cfb/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Skeleton } from '../../components/Skeleton';
import { EmptyState, ErrorState } from '../../components/States';
import { api, queryKeys } from '../../lib/api';
import { isApiError } from '../../lib/apiClient';
import { initials } from '../../lib/format';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import styles from './HomePage.module.css';

/** Names change only when the administrator changes them. */
const USERS_STALE_MS = 5 * 60_000;

/**
 * §15 — every board, one tap away. No menu, no intermediate page.
 */
export function HomePage() {
  useDocumentTitle(null);
  const users = useQuery({
    queryKey: queryKeys.users,
    queryFn: ({ signal }) => api.users(signal),
    staleTime: USERS_STALE_MS,
  });

  if (users.isError && users.data === undefined) {
    const error = users.error;
    return (
      <ErrorState
        title="Unable to load boards"
        message={error.message}
        requestId={isApiError(error) ? error.requestId : null}
        action={
          <button type="button" className="button" onClick={() => void users.refetch()}>
            Try again
          </button>
        }
      />
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Boards</h1>
      {users.data === undefined ? (
        <HomeSkeleton />
      ) : users.data.users.length === 0 ? (
        <EmptyState
          title="No boards yet"
          message="Boards appear here once the administrator adds people."
        />
      ) : (
        <ul className={styles.grid} role="list">
          {users.data.users.map((user) => (
            <li key={user.id}>
              <UserTile user={user} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UserTile({ user }: { user: UserSummary }) {
  const count = user.teamCount;
  return (
    <Link to={`/u/${user.id}`} className={styles.tile}>
      <span className={styles.monogram} aria-hidden="true">
        {initials(user.displayName)}
      </span>
      <span className={styles.name}>{user.displayName}</span>
      <span className={styles.count}>
        {String(count)} {count === 1 ? 'team' : 'teams'}
      </span>
    </Link>
  );
}

function HomeSkeleton() {
  return (
    <div role="status">
      <span className="visually-hidden">Loading boards…</span>
      <ul className={styles.grid} role="list" aria-hidden="true">
        {Array.from({ length: 9 }, (_, index) => (
          <li key={index} className={styles.tile}>
            <Skeleton width="3rem" height="3rem" className={styles.monogramSkeleton} />
            <Skeleton width="60%" height="1.5rem" />
            <Skeleton width="3.5rem" height="0.9rem" />
          </li>
        ))}
      </ul>
    </div>
  );
}
