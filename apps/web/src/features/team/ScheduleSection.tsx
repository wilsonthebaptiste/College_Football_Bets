import type { AppError, Game, ScheduleItem, TeamScheduleResponse } from '@cfb/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { FreshnessLabel } from '../../components/FreshnessLabel';
import { Opponent } from '../../components/GameLine';
import { LiveBadge } from '../../components/LiveBadge';
import { ResultMark } from '../../components/ResultMark';
import { Skeleton } from '../../components/Skeleton';
import { EmptyState, ErrorState } from '../../components/States';
import { TeamLogo } from '../../components/TeamLogo';
import { isApiError } from '../../lib/apiClient';
import { cx } from '../../lib/cx';
import {
  formatGameDate,
  formatKickoffTime,
  formatScore,
  formatUpdatedAt,
  scheduleStatus,
  weekLabel,
} from '../../lib/format';
import { unavailableMessage } from '../board/TeamCard';
import { Panel } from './Panel';
import styles from './ScheduleSection.module.css';

interface ScheduleSectionProps {
  /** The page's `useSchedule` query, started on mount alongside the team request. */
  query: UseQueryResult<TeamScheduleResponse>;
  /** The team's short name, for the table's caption: "Alabama". */
  teamName: string;
  /** The season the page is showing, for the title before the schedule arrives. */
  seasonYear: number;
  /** The snapshot's next game, marked in the list. `null` when unknown or none. */
  nextGameId: string | null;
}

/**
 * §17 — the team's whole season: every game with its week, date, opponent,
 * home or away, status, and result, and bye weeks as rows of their own.
 *
 * Two renderings of the same rows. From 720 px it is a real table, with a
 * caption and header cells, so a screen reader can move by row and column. On
 * a phone the rows become stacked entries with nothing to scroll sideways
 * (§34). CSS shows one and hides the other, and a hidden one is hidden from
 * assistive tech too.
 */
export function ScheduleSection({ query, teamName, seasonYear, nextGameId }: ScheduleSectionProps) {
  const response = query.data;
  const envelope = response?.schedule;
  const data = envelope?.data ?? null;
  const year = data?.season.year ?? seasonYear;
  const stale = envelope?.freshness.state === 'stale';
  const title = `${String(year)} schedule`;

  if (response === undefined) {
    if (!query.isError) {
      return (
        <Panel title={title}>
          <ScheduleSkeleton />
        </Panel>
      );
    }
    const error = query.error;
    return (
      <Panel title={title}>
        <ScheduleError
          message={isApiError(error) && error.kind === 'not_found' ? null : error.message}
          requestId={isApiError(error) ? error.requestId : null}
          onRetry={() => void query.refetch()}
        />
      </Panel>
    );
  }

  if (envelope === undefined || data === null) {
    const error: AppError | null = envelope?.error ?? null;
    return (
      <Panel title={title}>
        <ScheduleError
          message={unavailableMessage(error)}
          requestId={error?.requestId ?? null}
          onRetry={() => void query.refetch()}
        />
      </Panel>
    );
  }

  const games = data.items.filter((item) => item.kind === 'game').length;
  return (
    <Panel
      title={title}
      stale={stale}
      aside={
        games > 0 && (
          <span className={styles.count}>
            {games} {games === 1 ? 'game' : 'games'}
          </span>
        )
      }
    >
      {data.items.length === 0 ? (
        <EmptyState
          headingLevel={3}
          title="No games scheduled"
          message={`${teamName} has no games on its ${String(year)} schedule yet.`}
        />
      ) : (
        <>
          <ScheduleTable
            items={data.items}
            teamName={teamName}
            year={year}
            nextGameId={nextGameId}
          />
          <ScheduleList
            items={data.items}
            teamName={teamName}
            year={year}
            nextGameId={nextGameId}
          />
        </>
      )}
      <ScheduleFooter
        stale={stale}
        fetchedAt={envelope.freshness.fetchedAt}
        refreshFailed={query.isRefetchError}
      />
    </Panel>
  );
}

interface RowsProps {
  items: ScheduleItem[];
  teamName: string;
  year: number;
  nextGameId: string | null;
}

/** A stable React key per row. A bye has no id, but has its week. */
function keyOf(item: ScheduleItem, index: number): string {
  return item.kind === 'game'
    ? item.game.providerGameId
    : `bye-${String(item.week ?? 'x')}-${String(index)}`;
}

function rowTone(game: Game, nextGameId: string | null): string | undefined {
  if (game.status === 'live') return styles.live;
  if (game.providerGameId === nextGameId) return styles.next;
  return undefined;
}

// ─── Desktop: a real table ───────────────────────────────────────────────────

export function ScheduleTable({ items, teamName, year, nextGameId }: RowsProps) {
  return (
    <table className={styles.table}>
      <caption className="visually-hidden">
        {teamName}’s {String(year)} schedule: each game’s week, date, opponent, home or away,
        status, and result.
      </caption>
      <thead>
        <tr>
          <th scope="col" className={styles.weekCol}>
            Week
          </th>
          <th scope="col">Date</th>
          <th scope="col">Opponent</th>
          <th scope="col">
            <span aria-hidden="true">H/A</span>
            <span className="visually-hidden">Home or away</span>
          </th>
          <th scope="col">Status</th>
          <th scope="col" className={styles.resultCol}>
            Result
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) =>
          item.kind === 'bye' ? (
            <tr key={keyOf(item, index)} className={styles.byeRow}>
              <td className={styles.week}>{item.week === null ? '—' : String(item.week)}</td>
              <td colSpan={5} className={styles.byeCell}>
                Bye week
              </td>
            </tr>
          ) : (
            <GameRow key={keyOf(item, index)} game={item.game} nextGameId={nextGameId} />
          ),
        )}
      </tbody>
    </table>
  );
}

const HOME_AWAY_WORDS = { home: 'Home', away: 'Away', neutral: 'Neutral' } as const;

function GameRow({ game, nextGameId }: { game: Game; nextGameId: string | null }) {
  return (
    <tr className={rowTone(game, nextGameId)}>
      <td className={styles.week}>{weekLabel(game)}</td>
      <td className={styles.date}>
        <time dateTime={game.kickoffUtc}>{formatGameDate(game)}</time>{' '}
        <span className={styles.time}>{formatKickoffTime(game)}</span>
      </td>
      <th scope="row" className={styles.opponentCell}>
        <span className={styles.opponent}>
          <TeamLogo
            src={game.opponent.logoUrl}
            name={game.opponent.name}
            abbreviation={game.opponent.abbreviation}
            size={24}
            decorative
          />
          <span className={styles.opponentText}>
            <span className={styles.opponentName}>{game.opponent.name}</span>
            {game.venue !== null && game.venue.trim() !== '' && (
              <>
                {' '}
                <span className={styles.venue}>{game.venue}</span>
              </>
            )}
          </span>
        </span>
      </th>
      <td>{HOME_AWAY_WORDS[game.homeAway]}</td>
      <td>
        <Status game={game} next={game.providerGameId === nextGameId} />
      </td>
      <td className={styles.result}>
        <Result game={game} />
      </td>
    </tr>
  );
}

// ─── Phones: stacked entries ─────────────────────────────────────────────────

export function ScheduleList({ items, teamName, year, nextGameId }: RowsProps) {
  return (
    <ol className={styles.list} role="list" aria-label={`${teamName}’s ${String(year)} schedule`}>
      {items.map((item, index) =>
        item.kind === 'bye' ? (
          <li key={keyOf(item, index)} className={cx(styles.entry, styles.byeEntry)}>
            {item.week !== null && <p className={styles.meta}>Week {String(item.week)}</p>}
            <p className={styles.byeCell}>Bye week</p>
          </li>
        ) : (
          <GameEntry key={keyOf(item, index)} game={item.game} nextGameId={nextGameId} />
        ),
      )}
    </ol>
  );
}

function GameEntry({ game, nextGameId }: { game: Game; nextGameId: string | null }) {
  const week = weekLabel(game);
  const weekText = /^\d+$/.test(week) ? `Week ${week}` : week === '—' ? null : week;
  const meta = [weekText, formatGameDate(game), formatKickoffTime(game)].filter(
    (part): part is string => part !== null,
  );
  return (
    <li className={cx(styles.entry, rowTone(game, nextGameId))}>
      <p className={styles.meta}>
        {meta.map((part, index) => (
          <span key={index}>
            {index > 0 && (
              <>
                <span aria-hidden="true"> ·</span>{' '}
              </>
            )}
            {index === 1 ? <time dateTime={game.kickoffUtc}>{part}</time> : part}
          </span>
        ))}
      </p>
      <div className={styles.entryMain}>
        <span className={styles.opponent}>
          <TeamLogo
            src={game.opponent.logoUrl}
            name={game.opponent.name}
            abbreviation={game.opponent.abbreviation}
            size={24}
            decorative
          />
          <Opponent game={game} />
        </span>{' '}
        <span className={styles.result}>
          <Result game={game} />
        </span>
      </div>
      <p className={styles.entryFoot}>
        <Status game={game} next={game.providerGameId === nextGameId} />
        {game.venue !== null && game.venue.trim() !== '' && (
          <>
            {' '}
            <span className={styles.venue}>{game.venue}</span>
          </>
        )}
      </p>
    </li>
  );
}

// ─── Cells shared by both renderings ─────────────────────────────────────────

/** Statuses that interrupt the ordinary run of a season, drawn as a tag (§18). */
const FLAGGED = new Set<Game['status']>([
  'postponed',
  'canceled',
  'delayed',
  'suspended',
  'unknown',
]);

/** §18 — the status in words. LIVE gets its badge; nothing but a final game says Final. */
function Status({ game, next }: { game: Game; next: boolean }) {
  return (
    <span className={styles.status}>
      {game.status === 'live' && (
        <>
          <LiveBadge />{' '}
        </>
      )}
      <span className={cx(FLAGGED.has(game.status) && styles.flag)}>{scheduleStatus(game)}</span>
      {next && (
        <>
          {' '}
          <span className={styles.nextTag}>Next</span>
        </>
      )}
    </span>
  );
}

/**
 * The score from the team's side. A final shows its result as letter, word,
 * and shape (§17); a game in progress shows the score with no verdict (§11); a
 * game with no score shows a dash, never a made-up 0–0 (§4).
 */
function Result({ game }: { game: Game }) {
  const hasScore = game.teamScore !== null && game.opponentScore !== null;
  if (game.result !== null) {
    return (
      <span className={styles.resultInner}>
        <ResultMark result={game.result} />
        {hasScore && ' '}
        {hasScore && (
          <span className={styles.score}>
            {formatScore(game.teamScore ?? 0, game.opponentScore ?? 0)}
          </span>
        )}
      </span>
    );
  }
  if (hasScore) {
    return (
      <span className={styles.score}>
        {formatScore(game.teamScore ?? 0, game.opponentScore ?? 0)}
      </span>
    );
  }
  if (game.status === 'live') return <span className={styles.muted}>Score unavailable</span>;
  return (
    <span className={styles.muted}>
      <span aria-hidden="true">—</span>
      <span className="visually-hidden">No score</span>
    </span>
  );
}

function ScheduleFooter({
  stale,
  fetchedAt,
  refreshFailed,
}: {
  stale: boolean;
  fetchedAt: string | null;
  refreshFailed: boolean;
}) {
  const shownAt = formatUpdatedAt(fetchedAt);
  return (
    <>
      {stale && <FreshnessLabel fetchedAt={fetchedAt} stale />}
      {/* Always present, so a screen reader is already listening when it fills. */}
      <p className={styles.notice} role="status">
        {refreshFailed
          ? `Couldn't refresh the schedule. ${shownAt === null ? 'Showing the last schedule received.' : `Showing the schedule from ${shownAt}.`}`
          : ''}
      </p>
    </>
  );
}

function ScheduleError({
  message,
  requestId,
  onRetry,
}: {
  message: string | null;
  requestId: string | null;
  onRetry: () => void;
}) {
  return (
    <ErrorState
      headingLevel={3}
      title="Schedule unavailable"
      message={message ?? 'The schedule could not be loaded. The rest of this page is unaffected.'}
      requestId={requestId}
      action={
        <button type="button" className="button-quiet" onClick={onRetry}>
          Try again
        </button>
      }
    />
  );
}

function ScheduleSkeleton() {
  return (
    <div className={styles.skeleton} role="status">
      <span className="visually-hidden">Loading schedule…</span>
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className={styles.skeletonRow} aria-hidden="true">
          <Skeleton width="2rem" height="1rem" />
          <Skeleton width="min(12rem, 45%)" height="1rem" />
          <Skeleton width="3.5rem" height="1rem" />
        </div>
      ))}
    </div>
  );
}
