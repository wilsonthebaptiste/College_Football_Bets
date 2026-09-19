import type { Game, NextGameSlot } from '@cfb/shared';
import type { ReactNode } from 'react';
import { useLocation, useParams } from 'react-router';
import { BackLink, readFromState } from '../../components/BackLink';
import { Card } from '../../components/Card';
import { FreshnessLabel } from '../../components/FreshnessLabel';
import { GameFacts, NextGameLine, PreviousGameLine } from '../../components/GameLine';
import { LiveScore } from '../../components/LiveScore';
import { Skeleton } from '../../components/Skeleton';
import { ErrorState } from '../../components/States';
import { RankBadge, RecordBadge } from '../../components/Standing';
import { TeamLogo } from '../../components/TeamLogo';
import { isApiError } from '../../lib/apiClient';
import { formatSeason, teamLabel } from '../../lib/format';
import { teamAccent } from '../../lib/teamColor';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import { unavailableMessage } from '../board/TeamCard';
import styles from './TeamPage.module.css';
import { useTeam } from './useTeam';

/**
 * §16 — one team. Phase 3 covers identity, rank, record, the live game, and
 * the previous and next games. The full schedule and the matchup prediction
 * are Phase 4, and load as their own sections so neither can blank this one.
 */
export function TeamPage() {
  const { teamId = '' } = useParams();
  const location = useLocation();
  const from = readFromState(location.state);
  const team = useTeam(teamId);
  const detail = team.data;
  useDocumentTitle(detail === undefined ? null : teamLabel(detail.team));

  const back =
    from === null ? (
      <BackLink to="/" label="All boards" />
    ) : (
      <BackLink to={from.path} label={from.label} isHistoryBack />
    );

  if (detail === undefined) {
    if (!team.isError) {
      return (
        <div className={styles.page} role="status">
          {back}
          <h1 className="visually-hidden">Loading team data…</h1>
          <div className={styles.hero} aria-hidden="true">
            <Skeleton width="72px" height="72px" round />
            <Skeleton width="min(18rem, 60%)" height="2.5rem" />
          </div>
        </div>
      );
    }
    const error = team.error;
    const notFound = isApiError(error) && error.kind === 'not_found';
    return (
      <div className={styles.page}>
        {back}
        <ErrorState
          title={notFound ? 'Team not found' : 'Unable to load team information'}
          message={notFound ? "There's no team at this address." : error.message}
          requestId={isApiError(error) ? error.requestId : null}
          action={
            notFound ? undefined : (
              <button type="button" className="button" onClick={() => void team.refetch()}>
                Try again
              </button>
            )
          }
        />
      </div>
    );
  }

  const { snapshot } = detail;
  const identity = detail.team;
  const name = teamLabel(identity);
  const data = snapshot.data;
  const stale = snapshot.freshness.state === 'stale';

  return (
    <div className={styles.page}>
      {back}

      <Card
        as="section"
        accent={teamAccent(identity.primaryColor, identity.altColor)}
        className={styles.heroCard}
      >
        <div className={styles.hero}>
          <TeamLogo
            src={identity.logoUrl}
            name={name}
            abbreviation={identity.abbreviation}
            size={72}
          />
          <div className={styles.identity}>
            <h1 className={styles.title}>{name}</h1>
            <p className={styles.subtitle}>
              {[identity.name !== name ? identity.name : null, identity.conference]
                .filter((part): part is string => part !== null)
                .join(', ')}
            </p>
          </div>
          {data !== null && (
            <div className={styles.standing}>
              <RankBadge ranking={data.ranking} />
              <RecordBadge record={data.record} />
            </div>
          )}
        </div>
        <div className={styles.heroFooter}>
          <span>{formatSeason(detail.season)}</span>
          <FreshnessLabel fetchedAt={snapshot.freshness.fetchedAt} stale={stale} />
        </div>
      </Card>

      {data === null ? (
        <ErrorState
          title={unavailableMessage(snapshot.error)}
          headingLevel={2}
          requestId={snapshot.error?.requestId ?? null}
        />
      ) : (
        <>
          {data.liveGame !== null && (
            <LiveScore game={data.liveGame} teamName={identity.abbreviation ?? name} size="page" />
          )}
          <div className={styles.panels}>
            <GamePanel title="Previous game">
              <PreviousGameLine game={data.previousGame} />
              {data.previousGame !== null && <GameFacts game={data.previousGame} played />}
            </GamePanel>
            <GamePanel title="Next game">
              <NextGameLine slot={data.nextGame} />
              <NextFacts slot={data.nextGame} />
            </GamePanel>
          </div>
        </>
      )}
    </div>
  );
}

function GamePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card as="section" className={styles.panel}>
      <h2 className={styles.panelTitle}>{title}</h2>
      {children}
    </Card>
  );
}

function NextFacts({ slot }: { slot: NextGameSlot }) {
  const game: Game | null =
    slot.kind === 'game' ? slot.game : slot.kind === 'bye' ? slot.following : null;
  return game === null ? null : <GameFacts game={game} played={false} />;
}
