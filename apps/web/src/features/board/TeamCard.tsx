import type { AppError, BoardTeam, Team } from '@cfb/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { FromState } from '../../components/BackLink';
import { Card } from '../../components/Card';
import { FreshnessLabel } from '../../components/FreshnessLabel';
import { NextGameLine, PreviousGameLine } from '../../components/GameLine';
import { LiveScore } from '../../components/LiveScore';
import { RankBadge, RecordBadge } from '../../components/Standing';
import { TeamLogo } from '../../components/TeamLogo';
import { teamLabel } from '../../lib/format';
import { teamAccent } from '../../lib/teamColor';
import styles from './TeamCard.module.css';

/** §38 — the words a card uses when its sports data is missing. */
export function unavailableMessage(error: AppError | null): string {
  if (error?.kind === 'provider_invalid_response') return 'Sports data could not be read.';
  if (error?.kind === 'not_found') return 'No sports data found for this team.';
  return 'Sports data temporarily unavailable.';
}

interface TeamCardProps {
  entry: BoardTeam;
  /** Where the team page's back link should return to. */
  from: FromState['from'];
}

/**
 * One team on a board (§13, §14): identity, rank and record, then what is
 * happening now. A live game comes first (§11, §51), then the previous and
 * next games.
 *
 * The whole card is clickable through one real link, the team name, stretched
 * over the card. Keyboard, middle-click, and "open in new tab" all work, and a
 * screen reader hears "Alabama, link" rather than the entire card read out as
 * one link name (§48).
 */
export function TeamCard({ entry, from }: TeamCardProps) {
  const { team, snapshot } = entry;
  const data = snapshot.data;
  const stale = snapshot.freshness.state === 'stale';
  const name = teamLabel(team);

  return (
    <Card
      as="article"
      accent={teamAccent(team.primaryColor, team.altColor)}
      stale={stale}
      className={styles.card}
    >
      <CardHeader team={team} from={from}>
        {data !== null && (
          <div className={styles.standing}>
            <RankBadge ranking={data.ranking} />
            <RecordBadge record={data.record} />
          </div>
        )}
      </CardHeader>

      {data === null ? (
        <p className={styles.unavailable}>{unavailableMessage(snapshot.error)}</p>
      ) : (
        <>
          {data.liveGame !== null && (
            <LiveScore game={data.liveGame} teamName={team.abbreviation ?? name} />
          )}
          <dl className={styles.games}>
            <div className={styles.row}>
              <dt className={styles.label}>Previous</dt>
              <dd className={styles.value}>
                <PreviousGameLine game={data.previousGame} />
              </dd>
            </div>
            <div className={styles.row}>
              <dt className={styles.label}>Next</dt>
              <dd className={styles.value}>
                <NextGameLine slot={data.nextGame} />
              </dd>
            </div>
          </dl>
        </>
      )}

      {stale && (
        <FreshnessLabel
          fetchedAt={snapshot.freshness.fetchedAt}
          stale
          className={styles.staleNote}
        />
      )}
    </Card>
  );
}

function CardHeader({
  team,
  from,
  children,
}: {
  team: Team;
  from: FromState['from'];
  children?: ReactNode;
}) {
  const name = teamLabel(team);
  const state: FromState = { from };
  return (
    <header className={styles.head}>
      <TeamLogo src={team.logoUrl} name={name} abbreviation={team.abbreviation} size={48} />
      <div className={styles.identity}>
        <h2 className={styles.name}>
          <Link to={`/teams/${team.id}`} state={state} className={styles.link}>
            {name}
          </Link>
        </h2>
        {team.conference !== null && <p className={styles.conference}>{team.conference}</p>}
      </div>
      {children}
    </header>
  );
}

/**
 * What a card becomes when rendering it threw (its `ErrorBoundary` fallback).
 * The team's identity is application data and still safe to show (§42).
 */
export function TeamCardFallback({ team, from }: { team: Team; from: FromState['from'] }) {
  return (
    <Card
      as="article"
      accent={teamAccent(team.primaryColor, team.altColor)}
      className={styles.card}
    >
      <CardHeader team={team} from={from} />
      <p className={styles.unavailable}>Unable to display this team.</p>
    </Card>
  );
}
