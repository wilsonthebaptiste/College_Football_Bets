import type { BoardResponse } from '@cfb/shared';
import { useParams } from 'react-router';
import { BackLink, type FromState } from '../../components/BackLink';
import { Card } from '../../components/Card';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { FreshnessLabel } from '../../components/FreshnessLabel';
import { RefreshIcon } from '../../components/icons';
import { Skeleton } from '../../components/Skeleton';
import { EmptyState, ErrorState } from '../../components/States';
import { isApiError } from '../../lib/apiClient';
import { cx } from '../../lib/cx';
import { formatSeason, formatUpdatedAt } from '../../lib/format';
import { rankingPollOf, summarizeBoardFreshness } from '../../lib/freshness';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import styles from './BoardPage.module.css';
import { TeamCard, TeamCardFallback } from './TeamCard';
import { useBoard } from './useBoard';

/**
 * §13 — one person's six teams, compared at a glance, from one request (§27).
 *
 * The skeleton shows on the FIRST load only. After that the board stays on
 * screen through every refetch, with a quiet "Refreshing…" in the header; it
 * never flashes back to placeholders (§37).
 */
export function BoardPage() {
  const { userId = '' } = useParams();
  const board = useBoard(userId);
  const data = board.data;
  useDocumentTitle(data === undefined ? null : `${data.user.displayName}'s board`);

  if (data === undefined) {
    if (!board.isError) return <BoardSkeleton />;

    const error = board.error;
    if (isApiError(error) && error.kind === 'not_found') {
      return (
        <div className={styles.page}>
          <BackLink to="/" label="All boards" />
          <ErrorState
            title="Board not found"
            message="There's no board at this address. It may have been removed."
          />
        </div>
      );
    }
    return (
      <div className={styles.page}>
        <BackLink to="/" label="All boards" />
        <ErrorState
          title="Unable to load this board"
          message={error.message}
          requestId={isApiError(error) ? error.requestId : null}
          action={
            <button type="button" className="button" onClick={() => void board.refetch()}>
              Try again
            </button>
          }
        />
      </div>
    );
  }

  const from: FromState['from'] = {
    path: `/u/${data.user.id}`,
    label: `${data.user.displayName}'s board`,
  };

  return (
    <div className={styles.page}>
      <BackLink to="/" label="All boards" />
      <BoardHeader
        board={data}
        refreshing={board.isFetching}
        refreshFailed={board.isRefetchError}
        onRefresh={() => void board.refetch()}
      />

      {data.teams.length === 0 ? (
        <EmptyState
          title="No teams yet"
          message={`${data.user.displayName} hasn't been given any teams. The administrator adds them.`}
        />
      ) : (
        <ul className={styles.grid} role="list" aria-label={`${data.user.displayName}'s teams`}>
          {data.teams.map((entry) => (
            <li key={entry.selectionId} className={styles.cell}>
              <ErrorBoundary
                resetKey={board.dataUpdatedAt}
                fallback={<TeamCardFallback team={entry.team} from={from} />}
              >
                <TeamCard entry={entry} from={from} />
              </ErrorBoundary>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface BoardHeaderProps {
  board: BoardResponse;
  refreshing: boolean;
  refreshFailed: boolean;
  onRefresh: () => void;
}

function BoardHeader({ board, refreshing, refreshFailed, onRefresh }: BoardHeaderProps) {
  const freshness = summarizeBoardFreshness(board);
  const poll = rankingPollOf(board);
  const shownAt = formatUpdatedAt(freshness.oldestFetchedAt);

  return (
    <header className={styles.header}>
      <h1 className={styles.title}>{board.user.displayName}</h1>
      <p className={styles.meta}>
        <span>{formatSeason(board.season)}</span>
        {poll !== null && <span>Rankings: {poll}</span>}
      </p>

      <div className={styles.status}>
        <FreshnessLabel fetchedAt={freshness.oldestFetchedAt} stale={freshness.anyStale} />
        <button
          type="button"
          className={cx('button-quiet', styles.refresh)}
          onClick={() => {
            if (!refreshing) onRefresh();
          }}
          aria-disabled={refreshing}
        >
          <RefreshIcon className={cx(refreshing && styles.spinning)} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Announced politely, once per change, never on every poll. */}
      <p className={styles.notice} role="status">
        {refreshFailed
          ? `Couldn't refresh the board. ${shownAt === null ? 'Showing the last data received.' : `Showing data from ${shownAt}.`}`
          : ''}
      </p>
    </header>
  );
}

function BoardSkeleton() {
  return (
    <div className={styles.page} role="status">
      <h1 className="visually-hidden">Loading board…</h1>
      <div className={styles.header} aria-hidden="true">
        <Skeleton width="4rem" height="1rem" />
        <Skeleton width="min(20rem, 70%)" height="3.25rem" />
        <Skeleton width="12rem" height="1rem" />
      </div>
      <ul className={styles.grid} role="list" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <li key={index} className={styles.cell}>
            <Card className={styles.skeletonCard}>
              <div className={styles.skeletonHead}>
                <Skeleton width="48px" height="48px" round />
                <Skeleton width="60%" height="1.4rem" />
                <Skeleton width="2.5rem" height="2rem" />
              </div>
              <Skeleton height="1rem" />
              <Skeleton width="80%" height="1rem" />
              <Skeleton width="55%" height="0.9rem" />
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
