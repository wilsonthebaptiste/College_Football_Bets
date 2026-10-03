import type { BoardProjectionSummary, ProjectionsResponse, UserSummary } from '@cfb/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ProjectionNote } from '../../components/Projection';
import { Skeleton } from '../../components/Skeleton';
import { EmptyState, ErrorState } from '../../components/States';
import { api, queryKeys } from '../../lib/api';
import { isApiError } from '../../lib/apiClient';
import { formatPoints, initials } from '../../lib/format';
import { POLL } from '../../lib/poll';
import { coverageNote } from '../../lib/projection';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import styles from './HomePage.module.css';

/** Names change only when the administrator changes them. */
const USERS_STALE_MS = 5 * 60_000;

/** What a tile knows about its person's projection. */
type TileProjection =
  | { kind: 'loading' }
  /** Failed, or this person is not on the leaderboard yet: the tile shows nothing. */
  | { kind: 'none' }
  | { kind: 'summary'; summary: BoardProjectionSummary };

/**
 * §15 — every board, one tap away. No menu, no intermediate page.
 *
 * Each tile also carries its person's projected total (predicting_score.md,
 * Phase 4), from ONE leaderboard request for the whole page. That request is
 * independent of the people list and the tiles never wait for it: a failed or
 * slow projection costs the page its totals and nothing else, which is the
 * `PickedBy` precedent (§42). The tiles keep the people list's order rather
 * than the leaderboard's, so nothing moves when the totals arrive and nobody
 * is presented as "winning" — it is a projection, and ties will happen.
 */
export function HomePage() {
  useDocumentTitle(null);
  const users = useQuery({
    queryKey: queryKeys.users,
    queryFn: ({ signal }) => api.users(signal),
    staleTime: USERS_STALE_MS,
  });
  const projections = useQuery({
    queryKey: queryKeys.projections,
    queryFn: ({ signal }) => api.projections(signal),
    staleTime: POLL.projectionMs,
    refetchInterval: POLL.projectionMs,
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

  const projectionOf = (userId: string): TileProjection => {
    if (projections.data === undefined) {
      return projections.isError ? { kind: 'none' } : { kind: 'loading' };
    }
    const summary = projections.data.boards.find((board) => board.userId === userId);
    return summary === undefined ? { kind: 'none' } : { kind: 'summary', summary };
  };

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
        <>
          <ul className={styles.grid} role="list">
            {users.data.users.map((user) => (
              <li key={user.id}>
                <UserTile user={user} projection={projectionOf(user.id)} />
              </li>
            ))}
          </ul>
          <ProjectionFootnote
            data={projections.data}
            failed={projections.isError && projections.data === undefined}
          />
        </>
      )}
    </div>
  );
}

function UserTile({ user, projection }: { user: UserSummary; projection: TileProjection }) {
  const count = user.teamCount;
  // The spaces between the parts are for the link's accessible name: without
  // them it is announced "Casey6 teams". A grid ignores them on screen.
  return (
    <Link to={`/u/${user.id}`} className={styles.tile}>
      <span className={styles.monogram} aria-hidden="true">
        {initials(user.displayName)}
      </span>{' '}
      <span className={styles.name}>{user.displayName}</span>{' '}
      <span className={styles.count}>
        {String(count)} {count === 1 ? 'team' : 'teams'}
      </span>{' '}
      <TileTotal projection={projection} />
    </Link>
  );
}

/**
 * The tile's projected total. Always rendered, so the tile keeps its height
 * whether the total is loading, failed, or here. The number comes first, then
 * what it is, then how much of the board is behind it — a board at "3 of 6"
 * is not comparable to one at "6 of 6", so the count is never left off.
 */
function TileTotal({ projection }: { projection: TileProjection }) {
  if (projection.kind === 'loading') {
    return (
      <span className={styles.projection}>
        <Skeleton width="8rem" height="0.9rem" />
      </span>
    );
  }
  if (projection.kind === 'none') return <span className={styles.projection} />;

  const { total, teamsCounted, teamsTotal } = projection.summary;
  // A board with no teams has nothing to project, and its count already says so.
  if (teamsTotal === 0) return <span className={styles.projection} />;
  if (total === null) {
    return <span className={styles.projection}>No projected total</span>;
  }
  const coverage = coverageNote(teamsCounted, teamsTotal);
  return (
    <span className={styles.projection}>
      <span className={styles.points}>{formatPoints(total)}</span> projected points
      {coverage !== null && <> {coverage}</>}
    </span>
  );
}

/**
 * Once, under the tiles: what the totals are and where they came from. A
 * failure is a quiet line, not an alert — the page's job is the boards, and
 * those are all here.
 */
function ProjectionFootnote({
  data,
  failed,
}: {
  data: ProjectionsResponse | undefined;
  failed: boolean;
}) {
  if (data !== undefined) return <ProjectionNote sources={data.sources} className={styles.note} />;
  if (failed) {
    return <p className={styles.note}>Projected points are unavailable right now.</p>;
  }
  return null;
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
            <Skeleton width="8rem" height="0.9rem" />
          </li>
        ))}
      </ul>
    </div>
  );
}
