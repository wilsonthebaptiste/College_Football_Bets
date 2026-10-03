import type { Matchup, MatchupOwner, MatchupSide } from '@cfb/shared';
import { Fragment } from 'react';
import { StatusTag } from '../../components/GameLine';
import { LiveBadge } from '../../components/LiveBadge';
import { ResultMark } from '../../components/ResultMark';
import { ApiError, isApiError } from '../../lib/apiClient';
import {
  formatGameDate,
  formatKickoff,
  formatKickoffTime,
  liveSituation,
  scheduleStatus,
  statusLabel,
} from '../../lib/format';
import { resultOf, sectionOf } from '../../lib/matchup';
import styles from './parts.module.css';

/**
 * The pieces the matchup board's cards and the game page both print, so the
 * two cannot describe the same game in different words.
 */

interface StatusProps {
  row: Matchup;
  /**
   * `card`: inside a day's group, so an upcoming game shows its time alone.
   * `page`: on its own, so every state carries its date.
   */
  context: 'card' | 'page';
}

/**
 * Where the game stands, in words: LIVE and the situation, the kickoff, or
 * the provider's own "Final". Nothing says Final unless the status does (§11),
 * and halftime, a delay, or a suspension shows the provider's own wording.
 */
export function MatchupStatus({ row, context }: StatusProps) {
  const section = sectionOf(row);
  switch (section) {
    case 'live': {
      const situation = liveSituation(row);
      if (row.status === 'live') {
        return (
          <span className={styles.status}>
            <LiveBadge /> <span className={styles.situation}>{situation}</span>
          </span>
        );
      }
      // Delayed or suspended mid-game: no running clock, so no LIVE badge.
      const label = statusLabel(row) ?? 'In progress';
      return (
        <span className={styles.status}>
          <StatusTag>{label}</StatusTag>
          {situation.toLowerCase() !== label.toLowerCase() && (
            <>
              {' '}
              <span className={styles.situation}>{situation}</span>
            </>
          )}
        </span>
      );
    }
    case 'upcoming': {
      const label = statusLabel(row);
      const when =
        context === 'page'
          ? formatKickoff(row)
          : row.kickoffTbd
            ? 'Time TBD'
            : formatKickoffTime(row);
      return (
        <span className={styles.status}>
          {label !== null && (
            <>
              <StatusTag>{label}</StatusTag>{' '}
            </>
          )}
          <time className={styles.when} dateTime={row.kickoffUtc}>
            {when}
          </time>
        </span>
      );
    }
    case 'final':
      return (
        <span className={styles.status}>
          <span className={styles.final}>{scheduleStatus(row)}</span>{' '}
          <time className={styles.when} dateTime={row.kickoffUtc}>
            {formatGameDate(row)}
          </time>
        </span>
      );
    case 'off':
      return (
        <span className={styles.status}>
          <StatusTag>{statusLabel(row) ?? 'Status unknown'}</StatusTag>{' '}
          <time className={styles.when} dateTime={row.kickoffUtc}>
            {context === 'page' ? formatKickoff(row) : formatGameDate(row)}
          </time>
        </span>
      );
  }
}

/**
 * "Axel", or "Jordan, Wilson" — sorted by the server, wrapped by the browser.
 * Plain text: on a card the matchup is the one link, and nested links inside a
 * stretched link break keyboard order. The game page links each name instead.
 */
export function OwnerNames({ owners }: { owners: readonly MatchupOwner[] }) {
  if (owners.length === 0) return <span className={styles.nobody}>Not on a board</span>;
  return (
    <span className={styles.owners}>
      <span className="visually-hidden">Picked by </span>
      {owners.map((owner, index) => (
        <Fragment key={owner.userId}>
          {index > 0 && ', '}
          <span className={styles.owner}>{owner.displayName}</span>
        </Fragment>
      ))}
    </span>
  );
}

/** A side's score, with the result mark once the provider says final. */
export function SideScore({
  row,
  side,
  size = 'card',
}: {
  row: Matchup;
  side: 'home' | 'away';
  size?: 'card' | 'page';
}) {
  const score: MatchupSide['score'] = row[side].score;
  if (score === null) return null;
  const result = resultOf(row, side);
  return (
    <span className={size === 'page' ? styles.scorePage : styles.score}>
      {result !== null && (
        <>
          <ResultMark result={result} />{' '}
        </>
      )}
      <span className="visually-hidden">score </span>
      {String(score)}
    </span>
  );
}

/** What a failed read says, in words, by what went wrong (§38). */
export function failureCopy(error: Error, what: string): { title: string; message: string } {
  if (isApiError(error) && error.kind === 'rate_limited') {
    return {
      title: 'Too many requests',
      message: 'Wait a moment, then try again.',
    };
  }
  return { title: `Unable to load ${what}`, message: error.message };
}

export function requestIdOf(error: Error): string | null {
  return error instanceof ApiError ? error.requestId : null;
}
