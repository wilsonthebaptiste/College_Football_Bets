import type { Matchup } from '@cfb/shared';
import { Link } from 'react-router';
import type { FromState } from '../../components/BackLink';
import { Card } from '../../components/Card';
import { FreshnessLabel } from '../../components/FreshnessLabel';
import { HomeAwayMark } from '../../components/GameLine';
import { RankBadge, RecordBadge } from '../../components/Standing';
import { TeamLogo } from '../../components/TeamLogo';
import { cx } from '../../lib/cx';
import { formatUpdatedAt, teamLabel } from '../../lib/format';
import { matchupPath, matchupTitle, sameOwnerNote, scoreState, sectionOf } from '../../lib/matchup';
import styles from './MatchupCard.module.css';
import { MatchupStatus, OwnerNames, SideScore } from './parts';

interface MatchupCardProps {
  row: Matchup;
  /** Where the game page's back link returns to: this board, this week. */
  from: FromState['from'];
  /** `h3` under a section's `h2`; `h4` under an upcoming day's `h3`. */
  headingLevel: 3 | 4;
}

/**
 * One game between two boards (plan-matchup-board, Phase 2): away over home,
 * each with its logo, name, rank, record, and whose board it is on; the score
 * and status; and, before kickoff, the time and TV.
 *
 * The card's one link is the matchup's name, stretched over the whole card
 * with `::after` as `TeamCard` does. Team and owner names are deliberately not
 * links inside it: a link nested in a stretched link breaks keyboard order.
 * The game page links on to the teams and the boards.
 *
 * Only the two score rows of a game in progress are a live region, so a
 * Saturday board announces a score when it changes and not the clock, the
 * TV, or the other eleven cards on every poll.
 */
export function MatchupCard({ row, from, headingLevel }: MatchupCardProps) {
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  const section = sectionOf(row);
  const live = section === 'live';
  const score = scoreState(row);
  const stale = row.freshness.state === 'stale';
  const together = sameOwnerNote(row);
  const updated = live ? formatUpdatedAt(row.scoreUpdatedAt) : null;
  const facts = [
    section === 'upcoming' && row.broadcast !== null && row.broadcast.trim() !== ''
      ? `TV: ${row.broadcast}`
      : null,
    row.neutralSite ? 'Neutral site' : null,
  ].filter((fact): fact is string => fact !== null);

  return (
    <Card as="article" stale={stale} className={cx(styles.card, live && styles.live)}>
      <div className={styles.head}>
        <Heading className={styles.title}>
          <Link to={matchupPath(row.providerGameId)} state={{ from }} className={styles.link}>
            {matchupTitle(row)}
          </Link>
        </Heading>{' '}
        <MatchupStatus row={row} context="card" />
      </div>

      <div
        className={styles.sides}
        {...(live ? { 'aria-live': 'polite' as const, 'aria-atomic': true } : {})}
      >
        <SideRow row={row} side="away" />
        <SideRow row={row} side="home" />
        {score === 'missing' && <p className={styles.noScore}>Score unavailable</p>}
        {score === 'failed' && <p className={styles.noScore}>Score temporarily unavailable</p>}
      </div>

      {together !== null && <p className={styles.together}>{together}</p>}

      {(facts.length > 0 || (updated !== null && row.scoreUpdatedAt !== null)) && (
        <p className={styles.facts}>
          {updated !== null && row.scoreUpdatedAt !== null && (
            <span>
              Updated <time dateTime={row.scoreUpdatedAt}>{updated}</time>
            </span>
          )}
          {facts.map((fact) => (
            <span key={fact}> {fact}</span>
          ))}
        </p>
      )}

      {stale && (
        <FreshnessLabel fetchedAt={row.freshness.fetchedAt} stale className={styles.staleNote} />
      )}
    </Card>
  );
}

function SideRow({ row, side }: { row: Matchup; side: 'home' | 'away' }) {
  const { team, ranking, record, owners } = row[side];
  const name = teamLabel(team);
  return (
    <div className={styles.side}>
      <TeamLogo
        src={team.logoUrl}
        name={name}
        abbreviation={team.abbreviation}
        size={36}
        decorative
      />
      <p className={styles.identity}>
        <span className={styles.name}>
          {side === 'home' && (
            <>
              <HomeAwayMark homeAway={row.neutralSite ? 'neutral' : 'away'} />{' '}
            </>
          )}
          {name}
        </span>{' '}
        <span className={styles.meta}>
          <RankBadge ranking={ranking} size="sm" /> <RecordBadge record={record} size="sm" />{' '}
          <OwnerNames owners={owners} />
        </span>
      </p>{' '}
      <SideScore row={row} side={side} />
    </div>
  );
}

/**
 * What a card becomes when rendering it threw (its `ErrorBoundary`
 * fallback): both teams still named, through the same one link (§42).
 */
export function MatchupCardFallback({ row, from, headingLevel }: MatchupCardProps) {
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  return (
    <Card as="article" className={styles.card}>
      <Heading className={styles.title}>
        <Link to={matchupPath(row.providerGameId)} state={{ from }} className={styles.link}>
          {matchupTitle(row)}
        </Link>
      </Heading>
      <p className={styles.noScore}>Unable to display this game.</p>
    </Card>
  );
}
