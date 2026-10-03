import type { BoardProjectionResponse, ProjectedTeamEntry } from '@cfb/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { Card } from '../../components/Card';
import { ChevronLeftIcon } from '../../components/icons';
import { ProjectionLines, ProjectionNote } from '../../components/Projection';
import { Skeleton } from '../../components/Skeleton';
import { isApiError } from '../../lib/apiClient';
import { formatPoints, teamLabel } from '../../lib/format';
import { coverageNote, linesCounted, ROUNDING_NOTE } from '../../lib/projection';
import styles from './ProjectionPanel.module.css';

interface ProjectionPanelProps {
  query: UseQueryResult<BoardProjectionResponse>;
}

/**
 * A board's projected points (predicting_score.md, Phase 4): the board's total,
 * then one row per team, each opening to its six rubric lines.
 *
 * "Team total, expandable to lines" rather than a 36-cell grid, because six
 * teams of six lines is thirty-six numbers and a phone is 320 px wide. The
 * rows are native `<details>`, so opening one needs no script and works from a
 * keyboard as it is.
 *
 * Below the board's six cards and quieter than them (§51): a card says what a
 * team is doing now, and this is arithmetic over a publisher's daily odds.
 */
export function ProjectionPanel({ query }: ProjectionPanelProps) {
  const data = query.data;
  return (
    <Card
      as="section"
      stale={data !== undefined && data.freshness.state === 'stale'}
      className={styles.panel}
    >
      <h2 className={styles.title}>Projected points</h2>
      {data !== undefined ? (
        <Breakdown projection={data} />
      ) : query.isError ? (
        <Unavailable
          message={query.error.message}
          requestId={isApiError(query.error) ? query.error.requestId : null}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <div role="status" className={styles.loading}>
          <span className="visually-hidden">Loading projected points…</span>
          <Skeleton width="10rem" height="1.75rem" />
          <Skeleton height="0.9rem" />
          <Skeleton width="70%" height="0.9rem" />
        </div>
      )}
    </Card>
  );
}

function Breakdown({ projection }: { projection: BoardProjectionResponse }) {
  const { board, teams, sources } = projection;
  const coverage = coverageNote(board.teamsCounted, board.teamsTotal);

  return (
    <>
      {board.total === null ? (
        <p className={styles.noTotal}>
          {board.teamsTotal === 0 ? 'No teams to project yet.' : 'No projected total.'}
        </p>
      ) : (
        <p className={styles.total}>
          <span className={styles.totalValue}>{formatPoints(board.total)}</span> projected points
          {coverage !== null && <span className={styles.coverage}> {coverage}</span>}
        </p>
      )}

      <ProjectionNote sources={sources} withEstimateNote />

      {teams.length > 0 && (
        <ul role="list" className={styles.teams}>
          {teams.map((entry) => (
            <li key={entry.selectionId}>
              <TeamRow entry={entry} />
            </li>
          ))}
        </ul>
      )}

      {board.teamsCounted > 1 && <p className={styles.rounding}>{ROUNDING_NOTE}</p>}
    </>
  );
}

/**
 * One team: its total, then, opened, its six lines. A team with no total says
 * so in words rather than as a zero; a partial one says how many of its six
 * lines are behind the number it shows.
 */
function TeamRow({ entry }: { entry: ProjectedTeamEntry }) {
  const { projection } = entry;
  const counted = linesCounted(projection.terms);
  const status =
    projection.total === null
      ? 'not projected'
      : projection.complete
        ? null
        : `${String(counted)} of ${String(projection.terms.length)} lines`;

  return (
    <details className={styles.team}>
      <summary className={styles.summary}>
        <span className={styles.teamValue}>
          {projection.total === null ? (
            <span aria-hidden="true">—</span>
          ) : (
            <>
              {formatPoints(projection.total)}
              <span className="visually-hidden"> points:</span>
            </>
          )}
        </span>{' '}
        <span className={styles.teamName}>{teamLabel(entry.team)}</span>
        {status !== null && <span className={styles.teamStatus}> {status}</span>}
        <ChevronLeftIcon className={styles.chevron} />
      </summary>
      <div className={styles.lines}>
        <ProjectionLines terms={projection.terms} />
      </div>
    </details>
  );
}

function Unavailable({
  message,
  requestId,
  onRetry,
}: {
  message: string;
  requestId: string | null;
  onRetry: () => void;
}) {
  return (
    <div className={styles.unavailable}>
      <p className={styles.unavailableTitle}>Projected points unavailable</p>
      <p className={styles.reason}>{message} The board above is unaffected.</p>
      <div>
        <button type="button" className="button-quiet" onClick={onRetry}>
          Try again
        </button>
      </div>
      {requestId !== null && <p className={styles.reference}>Reference: {requestId}</p>}
    </div>
  );
}
