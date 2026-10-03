import type { TeamProjectionResponse } from '@cfb/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ProjectionLines, ProjectionNote } from '../../components/Projection';
import { Skeleton } from '../../components/Skeleton';
import { isApiError } from '../../lib/apiClient';
import { formatPoints } from '../../lib/format';
import { linesCounted } from '../../lib/projection';
import { Panel } from './Panel';
import styles from './ProjectionPanel.module.css';

interface TeamProjectionPanelProps {
  query: UseQueryResult<TeamProjectionResponse>;
}

/**
 * One team's projected points, beside its matchup prediction
 * (predicting_score.md, Phase 4): the total, its six rubric lines, and where
 * each came from. The same lines a board's breakdown opens to, from the same
 * component, so the two can never describe a team differently.
 *
 * Its own read and its own panel (§42): the hero, the games, the prediction and
 * the schedule all render without it.
 */
export function TeamProjectionPanel({ query }: TeamProjectionPanelProps) {
  const data = query.data;

  let body: ReactNode;
  if (data !== undefined) {
    body = <TeamBreakdown projection={data} />;
  } else if (query.isError) {
    body = (
      <div className={styles.unavailable}>
        <p className={styles.unavailableTitle}>Projected points unavailable</p>
        <p className={styles.reason}>{query.error.message}</p>
        {isApiError(query.error) && query.error.requestId !== null && (
          <p className={styles.reference}>Reference: {query.error.requestId}</p>
        )}
      </div>
    );
  } else {
    body = (
      <div role="status" className={styles.loading}>
        <span className="visually-hidden">Loading projected points…</span>
        <Skeleton width="9rem" height="1.5rem" />
        <Skeleton height="0.9rem" />
        <Skeleton width="75%" height="0.9rem" />
      </div>
    );
  }

  return (
    <Panel
      title="Projected points"
      stale={data !== undefined && data.freshness.state === 'stale'}
      className={styles.panel}
    >
      {body}
    </Panel>
  );
}

function TeamBreakdown({ projection }: { projection: TeamProjectionResponse }) {
  const { projection: team, sources } = projection;
  const anyInputDown = sources.some((entry) => entry.freshness.state === 'unavailable');

  return (
    <>
      {team.total === null ? (
        <div className={styles.unavailable}>
          <p className={styles.unavailableTitle}>No projection for this team</p>
          <p className={styles.reason}>
            {anyInputDown
              ? 'Its sources couldn’t be loaded. It will try again shortly.'
              : 'Neither publisher has figures for it. ESPN FPI rates FBS teams only.'}
          </p>
        </div>
      ) : (
        <>
          <p className={styles.total}>
            <span className={styles.totalValue}>{formatPoints(team.total)}</span> projected points
            {!team.complete && (
              <span className={styles.coverage}>
                {' '}
                from {String(linesCounted(team.terms))} of {String(team.terms.length)} lines
              </span>
            )}
          </p>
          <ProjectionLines terms={team.terms} />
        </>
      )}
      <ProjectionNote
        sources={sources}
        conference={projection.team.conference}
        withEstimateNote={team.total !== null}
      />
    </>
  );
}
