import type { Matchup, MatchupBoardResponse } from '@cfb/shared';
import { Link, useLocation, useSearchParams } from 'react-router';
import type { FromState } from '../../components/BackLink';
import { Card } from '../../components/Card';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { FreshnessLabel } from '../../components/FreshnessLabel';
import { ChevronLeftIcon, RefreshIcon } from '../../components/icons';
import { Skeleton } from '../../components/Skeleton';
import { EmptyState, ErrorState } from '../../components/States';
import { isApiError } from '../../lib/apiClient';
import { cx } from '../../lib/cx';
import { formatSeason, formatUpdatedAt } from '../../lib/format';
import {
  adjacentWeeks,
  groupMatchups,
  rankingPollOfMatchups,
  summarizeMatchupFreshness,
  weekLabel,
  weekPath,
} from '../../lib/matchup';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import { MatchupCard, MatchupCardFallback } from './MatchupCard';
import styles from './MatchupBoardPage.module.css';
import { failureCopy, requestIdOf } from './parts';
import { useMatchupBoard } from './useMatchups';

/** `?week=` as the URL has it, or `null` for "the current week, as the server decides". */
function weekParam(params: URLSearchParams): string | null {
  const raw = params.get('week')?.trim() ?? '';
  return raw === '' ? null : raw;
}

/** "Week 6 matchups", or "Matchups" when there is no week to name. */
function headingOf(board: MatchupBoardResponse): string {
  return board.week === null
    ? 'Matchups'
    : `${weekLabel(board.season, board.week, board.weeks)} matchups`;
}

/**
 * The matchup board (plan-matchup-board, Phase 2): every game in a week where
 * a team on one board plays a team on another, from one request.
 *
 * Live games first, then upcoming games by day in the viewer's own zone, then
 * finals, then postponed and canceled games — what is happening now comes
 * first (§51). The skeleton shows on the first load only; after that the
 * board stays on screen through every refetch, with "Refreshing…" (§37).
 */
export function MatchupBoardPage() {
  const [params] = useSearchParams();
  const location = useLocation();
  const week = weekParam(params);
  const board = useMatchupBoard(week);
  const data = board.data;
  useDocumentTitle(data === undefined ? 'Matchups' : headingOf(data));

  if (data === undefined) {
    if (!board.isError) return <BoardSkeleton />;
    const error = board.error;
    if (isApiError(error) && error.kind === 'invalid_request') {
      return (
        <div className={styles.page}>
          <ErrorState
            title="No such week"
            message={error.message}
            action={
              <Link to="/matchups" className="button">
                This week’s matchups
              </Link>
            }
          />
        </div>
      );
    }
    const copy = failureCopy(error, 'the matchups');
    return (
      <div className={styles.page}>
        <ErrorState
          title={copy.title}
          message={copy.message}
          requestId={requestIdOf(error)}
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
    path: `${location.pathname}${location.search}`,
    label: headingOf(data),
  };

  return (
    <div className={styles.page}>
      <BoardHeader
        board={data}
        refreshing={board.isFetching}
        refreshFailed={board.isRefetchError}
        onRefresh={() => void board.refetch()}
      />
      <BoardBody board={data} from={from} onRetry={() => void board.refetch()} />
    </div>
  );
}

interface BoardHeaderProps {
  board: MatchupBoardResponse;
  refreshing: boolean;
  refreshFailed: boolean;
  onRefresh: () => void;
}

function BoardHeader({ board, refreshing, refreshFailed, onRefresh }: BoardHeaderProps) {
  const freshness = summarizeMatchupFreshness(board);
  const poll = rankingPollOfMatchups(board.matchups);
  const shownAt = formatUpdatedAt(freshness.oldestFetchedAt);

  return (
    <header className={styles.header}>
      <h1 className={styles.title}>{headingOf(board)}</h1>
      <p className={styles.meta}>
        {/* A real space between the two: a flex gap is not one, and it would
            read and copy as "<yyyy> seasonRankings". */}
        <span>{formatSeason({ ...board.season, week: null })}</span>
        {poll !== null && (
          <>
            {' '}
            <span>Rankings: {poll}</span>
          </>
        )}
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

      <WeekNav board={board} />

      {/* Announced politely, once per change, never on every poll. */}
      <p className={styles.notice} role="status">
        {refreshFailed
          ? `Couldn't refresh the matchups. ${shownAt === null ? 'Showing the last data received.' : `Showing data from ${shownAt}.`}`
          : ''}
      </p>
    </header>
  );
}

/**
 * Previous and next week, as real links to `?week=` so the back button works
 * (§47). Each prints the calendar's own label, never "Week {n}": the
 * postseason's weeks are "Bowls" and "CFP". Hidden with no calendar.
 */
function WeekNav({ board }: { board: MatchupBoardResponse }) {
  const { previous, next } = adjacentWeeks(board.week, board.weeks);
  if (previous === null && next === null) return null;
  return (
    <nav aria-label="Weeks" className={styles.weekNav}>
      {previous !== null ? (
        <Link to={weekPath(previous.week)} className={styles.weekLink} rel="prev">
          <ChevronLeftIcon />
          <span className="visually-hidden">Previous week: </span>
          {previous.label}
        </Link>
      ) : (
        <span />
      )}{' '}
      {next !== null && (
        <Link to={weekPath(next.week)} className={cx(styles.weekLink, styles.next)} rel="next">
          <span className="visually-hidden">Next week: </span>
          {next.label}
          <ChevronLeftIcon className={styles.flip} />
        </Link>
      )}
    </nav>
  );
}

interface BoardBodyProps {
  board: MatchupBoardResponse;
  from: FromState['from'];
  onRetry: () => void;
}

function BoardBody({ board, from, onRetry }: BoardBodyProps) {
  const retry = (
    <button type="button" className="button" onClick={onRetry}>
      Try again
    </button>
  );

  if (board.notice === 'offseason') {
    return (
      <EmptyState
        title="No games this week"
        message="It’s the offseason. Matchups return when the provider publishes the next season’s weeks."
      />
    );
  }
  if (board.notice === 'week_unknown') {
    return (
      <ErrorState
        headingLevel={2}
        title="This week couldn’t be worked out"
        message="The season’s calendar is temporarily unavailable, so there is no week to show. It will try again shortly."
        requestId={board.error?.requestId ?? null}
        action={retry}
      />
    );
  }
  if (board.error !== null || board.freshness.state === 'unavailable') {
    return (
      <ErrorState
        headingLevel={2}
        title="Matchups temporarily unavailable"
        message="This week’s games couldn’t be loaded from the sports data provider. It will try again shortly."
        requestId={board.error?.requestId ?? null}
        action={retry}
      />
    );
  }
  if (board.matchups.length === 0) {
    return (
      <EmptyState
        title="No games between boards this week"
        message="No team on one board plays a team on another this week."
      />
    );
  }

  const sections = groupMatchups(board.matchups);
  return (
    <>
      <Section id="live" title="Live now" rows={sections.live} from={from} />
      {sections.upcoming.length > 0 && (
        <section className={styles.section} aria-labelledby="matchups-upcoming">
          <h2 id="matchups-upcoming" className={styles.sectionTitle}>
            Upcoming
          </h2>
          {sections.upcoming.map((day) => (
            <div key={day.key} className={styles.day}>
              <h3 className={styles.dayTitle}>{day.label}</h3>
              <Cards rows={day.rows} from={from} headingLevel={4} label={day.label} />
            </div>
          ))}
        </section>
      )}
      <Section id="final" title="Final" rows={sections.final} from={from} />
      <Section id="off" title="Postponed and canceled" rows={sections.off} from={from} />
    </>
  );
}

interface SectionProps {
  id: string;
  title: string;
  rows: Matchup[];
  from: FromState['from'];
}

/** One of the board's sections. An empty one is left out altogether. */
function Section({ id, title, rows, from }: SectionProps) {
  if (rows.length === 0) return null;
  const headingId = `matchups-${id}`;
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sectionTitle}>
        {title}
      </h2>
      <Cards rows={rows} from={from} headingLevel={3} label={title} />
    </section>
  );
}

interface CardsProps {
  rows: Matchup[];
  from: FromState['from'];
  headingLevel: 3 | 4;
  label: string;
}

/** Each card in its own error boundary: one game failing to render leaves the rest (§42). */
function Cards({ rows, from, headingLevel, label }: CardsProps) {
  return (
    <ul className={styles.grid} role="list" aria-label={label}>
      {rows.map((row) => (
        <li key={row.providerGameId} className={styles.cell}>
          <ErrorBoundary
            resetKey={row.scoreUpdatedAt ?? row.providerGameId}
            fallback={<MatchupCardFallback row={row} from={from} headingLevel={headingLevel} />}
          >
            <MatchupCard row={row} from={from} headingLevel={headingLevel} />
          </ErrorBoundary>
        </li>
      ))}
    </ul>
  );
}

function BoardSkeleton() {
  return (
    <div className={styles.page} role="status">
      <h1 className="visually-hidden">Loading matchups…</h1>
      <div className={styles.header} aria-hidden="true">
        <Skeleton width="min(22rem, 80%)" height="3.25rem" />
        <Skeleton width="10rem" height="1rem" />
      </div>
      <ul className={styles.grid} role="list" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <li key={index} className={styles.cell}>
            <Card className={styles.skeletonCard}>
              <Skeleton width="70%" height="1.25rem" />
              <Skeleton height="2.25rem" />
              <Skeleton height="2.25rem" />
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
