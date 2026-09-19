import type { Game, NextGameSlot } from '@cfb/shared';
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
import { predictionTarget } from '../../lib/prediction';
import { teamAccent } from '../../lib/teamColor';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import { unavailableMessage } from '../board/TeamCard';
import { Panel } from './Panel';
import { PredictionPanel } from './PredictionPanel';
import { ScheduleSection } from './ScheduleSection';
import styles from './TeamPage.module.css';
import { useSchedule } from './useSchedule';
import { useTeam } from './useTeam';

/**
 * §16 — one team: identity, rank, record, and conference; the live game; the
 * previous and next games; the matchup prediction; and the full schedule.
 *
 * The page is three independent reads (§42). The team snapshot drives the
 * hero and the game panels, the schedule is its own request, started on mount
 * alongside it (§27: never with the board), and the prediction follows once
 * the snapshot names the game. Any one of them can fail, and the others still
 * render.
 */
export function TeamPage() {
  const { teamId = '' } = useParams();
  const location = useLocation();
  const from = readFromState(location.state);
  const team = useTeam(teamId);
  const schedule = useSchedule(teamId);
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
        stale={stale}
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
              <RankBadge ranking={data.ranking} /> <RecordBadge record={data.record} />
            </div>
          )}
        </div>
        <div className={styles.heroFooter}>
          <span>
            {formatSeason(detail.season)}
            {data?.ranking.kind === 'ranked' && <> · Rankings: {data.ranking.poll}</>}
          </span>
          <FreshnessLabel fetchedAt={snapshot.freshness.fetchedAt} stale={stale} />
        </div>
      </Card>

      {data === null ? (
        <ErrorState
          title={unavailableMessage(snapshot.error)}
          message="The schedule below loads separately and may still be available."
          headingLevel={2}
          requestId={snapshot.error?.requestId ?? null}
        />
      ) : (
        <>
          {/* §11, §51: a game in progress comes before everything else. */}
          {data.liveGame !== null && (
            <LiveScore
              game={data.liveGame}
              teamName={identity.abbreviation ?? name}
              size="page"
              updatedAt={data.liveUpdatedAt}
            />
          )}
          <div className={styles.panels}>
            <Panel title="Previous game">
              <PreviousGameLine game={data.previousGame} />
              {data.previousGame !== null && <GameFacts game={data.previousGame} played />}
            </Panel>
            <Panel title="Next game">
              <NextGameLine slot={data.nextGame} />
              <NextFacts slot={data.nextGame} />
            </Panel>
            <PredictionPanel
              game={predictionTarget(data)}
              team={{ providerTeamId: identity.providerTeamId, name }}
            />
          </div>
        </>
      )}

      <ScheduleSection
        query={schedule}
        teamName={name}
        seasonYear={detail.season.year}
        nextGameId={data === null ? null : nextGameIdOf(data.nextGame)}
      />
    </div>
  );
}

function upcomingOf(slot: NextGameSlot): Game | null {
  return slot.kind === 'game' ? slot.game : slot.kind === 'bye' ? slot.following : null;
}

function nextGameIdOf(slot: NextGameSlot): string | null {
  return upcomingOf(slot)?.providerGameId ?? null;
}

function NextFacts({ slot }: { slot: NextGameSlot }) {
  const game = upcomingOf(slot);
  return game === null ? null : <GameFacts game={game} played={false} />;
}
