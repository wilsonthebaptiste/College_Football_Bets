import type { Matchup, MatchupResponse, Season } from '@cfb/shared';
import { Link, useLocation, useParams } from 'react-router';
import { BackLink, readFromState, type FromState } from '../../components/BackLink';
import { Card } from '../../components/Card';
import { FreshnessLabel } from '../../components/FreshnessLabel';
import { HomeAwayMark } from '../../components/GameLine';
import { PickedBy } from '../../components/PickedBy';
import { Skeleton } from '../../components/Skeleton';
import { ErrorState } from '../../components/States';
import { RankBadge, RecordBadge } from '../../components/Standing';
import { TeamLogo } from '../../components/TeamLogo';
import { isApiError } from '../../lib/apiClient';
import { cx } from '../../lib/cx';
import { formatSeason, formatUpdatedAt, teamLabel } from '../../lib/format';
import {
  matchupPath,
  matchupTitle,
  rankingPollOfMatchups,
  sameOwnerNote,
  scoreState,
  sectionOf,
  teamPath,
  weekPath,
} from '../../lib/matchup';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import { PredictionPanel, type PredictionSubject } from '../team/PredictionPanel';
import styles from './MatchupPage.module.css';
import { failureCopy, MatchupStatus, requestIdOf, SideScore } from './parts';
import { useMatchup } from './useMatchups';

/**
 * Where "back" goes when the page was not reached from a board: the matchup
 * board for THIS game's week, not `/matchups`, so a week-4 game returns to
 * week 4 (plan-matchup-board, Phase 2). The response carries no calendar, so
 * a postseason week is named by its phase rather than by a number that would
 * be wrong ("Week 999").
 */
function boardLinkFor(season: Season, week: number | null): FromState['from'] {
  if (week === null) return { path: '/matchups', label: 'All matchups' };
  const label = season.type === 'regular' ? `Week ${String(week)} matchups` : 'Postseason matchups';
  return { path: weekPath(week), label };
}

/**
 * One game (plan-matchup-board, Phase 2): both teams, whose boards they are
 * on, where the game stands, and — before and during it — who ESPN's matchup
 * predictor favours. Phase 3 fills in the game itself below.
 *
 * Two independent reads (§42): the game, and the prediction, which is the
 * team page's own panel with the order made neutral — away first, as the
 * heading reads, and neither side marked as the page's own.
 */
export function MatchupPage() {
  const { gameId = '' } = useParams();
  const location = useLocation();
  const from = readFromState(location.state);
  const query = useMatchup(gameId);
  const data = query.data;
  useDocumentTitle(data === undefined ? null : matchupTitle(data.matchup));

  const fallbackBack =
    data === undefined
      ? { path: '/matchups', label: 'All matchups' }
      : boardLinkFor(data.matchup.season, data.matchup.week);
  const back =
    from === null ? (
      <BackLink to={fallbackBack.path} label={fallbackBack.label} />
    ) : (
      <BackLink to={from.path} label={from.label} isHistoryBack />
    );

  if (data === undefined) {
    if (!query.isError) {
      return (
        <div className={styles.page} role="status">
          {back}
          <h1 className="visually-hidden">Loading game…</h1>
          <div className={styles.skeleton} aria-hidden="true">
            <Skeleton width="min(24rem, 80%)" height="2.5rem" />
            <Skeleton height="4.5rem" />
            <Skeleton height="4.5rem" />
          </div>
        </div>
      );
    }
    const error = query.error;
    const notFound = isApiError(error) && error.kind === 'not_found';
    const copy = failureCopy(error, 'this game');
    return (
      <div className={styles.page}>
        {back}
        <ErrorState
          title={notFound ? 'Game not found' : copy.title}
          message={notFound ? "There's no game at this address." : copy.message}
          requestId={notFound ? null : requestIdOf(error)}
          action={
            notFound ? (
              <Link to="/matchups" className="button">
                This week’s matchups
              </Link>
            ) : (
              <button type="button" className="button" onClick={() => void query.refetch()}>
                Try again
              </button>
            )
          }
        />
      </div>
    );
  }

  const row = data.matchup;
  return (
    <div className={styles.page}>
      {back}
      <GameHeader response={data} />
      {/* Never beside a result: a pregame number next to a final score is not
          information (team page, Phase 4 decision 1). */}
      {row.status !== 'final' && row.status !== 'canceled' && (
        <PredictionPanel title="Who’s favored" subject={predictionSubject(row)} />
      )}
    </div>
  );
}

/** The game page's prediction: away first, then home, neither marked as ours. */
function predictionSubject(row: Matchup): PredictionSubject {
  const named = (side: Matchup['home']) => ({
    providerTeamId: side.team.providerTeamId,
    name: teamLabel(side.team),
  });
  return {
    game: row,
    order: { kind: 'away_home', away: named(row.away), home: named(row.home) },
  };
}

function GameHeader({ response }: { response: MatchupResponse }) {
  const row = response.matchup;
  const title = matchupTitle(row);
  const section = sectionOf(row);
  const live = section === 'live';
  const stale = row.freshness.state === 'stale';
  const score = scoreState(row);
  const together = sameOwnerNote(row);
  const poll = rankingPollOfMatchups([row]);
  const here: FromState['from'] = { path: matchupPath(row.providerGameId), label: title };
  const updated = formatUpdatedAt(row.scoreUpdatedAt);
  const facts = [
    row.venue,
    row.neutralSite ? 'Neutral site' : null,
    row.broadcast === null ? null : `TV: ${row.broadcast}`,
  ].filter((fact): fact is string => fact !== null && fact.trim() !== '');

  return (
    <Card as="section" stale={stale} className={cx(styles.hero, live && styles.live)}>
      <div className={styles.titleRow}>
        <h1 className={styles.title}>{title}</h1>
        <MatchupStatus row={row} context="page" />
      </div>

      <div
        className={styles.sides}
        {...(live ? { 'aria-live': 'polite' as const, 'aria-atomic': true } : {})}
      >
        <SideBlock row={row} side="away" here={here} />
        <SideBlock row={row} side="home" here={here} />
      </div>
      {score === 'missing' && <p className={styles.noScore}>Score unavailable</p>}
      {score === 'failed' && <p className={styles.noScore}>Score temporarily unavailable</p>}

      {together !== null && <p className={styles.together}>{together}</p>}

      {facts.length > 0 && (
        <ul className={styles.facts} role="list">
          {facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      )}

      <div className={styles.footer}>
        <span>
          {formatSeason(response.season)}
          {poll !== null && <> · Rankings: {poll}</>}
        </span>
        {live && !stale && updated !== null && row.scoreUpdatedAt !== null ? (
          <p>
            Score updated <time dateTime={row.scoreUpdatedAt}>{updated}</time>
          </p>
        ) : (
          <FreshnessLabel fetchedAt={row.freshness.fetchedAt} stale={stale} />
        )}
      </div>
    </Card>
  );
}

interface SideBlockProps {
  row: Matchup;
  side: 'home' | 'away';
  /** This page, for the team page's back link. */
  here: FromState['from'];
}

/**
 * One team: logo, name (a link to its team page), rank, record, the boards it
 * is on (each a link), and its score. Owner names on a game page are no new
 * exposure — every board is public — but they are said here, as on search.
 */
function SideBlock({ row, side, here }: SideBlockProps) {
  const { team, ranking, record, owners } = row[side];
  const name = teamLabel(team);
  const state: FromState = { from: here };
  return (
    <div className={styles.side}>
      <TeamLogo src={team.logoUrl} name={name} abbreviation={team.abbreviation} size={56} />
      <div className={styles.identity}>
        <h2 className={styles.teamName}>
          {side === 'home' && (
            <>
              <HomeAwayMark homeAway={row.neutralSite ? 'neutral' : 'away'} />{' '}
            </>
          )}
          <Link to={teamPath(row[side])} state={state} className={styles.teamLink}>
            {name}
          </Link>
        </h2>
        <p className={styles.standing}>
          <RankBadge ranking={ranking} size="sm" /> <RecordBadge record={record} size="sm" />
        </p>
        {owners.length === 0 ? (
          <p className={styles.nobody}>Not on any board</p>
        ) : (
          <PickedBy owners={owners} />
        )}
      </div>{' '}
      <SideScore row={row} side={side} size="page" />
    </div>
  );
}
