import type { Game } from '@cfb/shared';
import type { ReactNode } from 'react';
import { FreshnessLabel } from '../../components/FreshnessLabel';
import { Opponent } from '../../components/GameLine';
import { Skeleton } from '../../components/Skeleton';
import { isApiError } from '../../lib/apiClient';
import { cssVars, cx } from '../../lib/cx';
import { formatKickoff, formatPercent } from '../../lib/format';
import { predictionView, type PredictionSideView } from '../../lib/prediction';
import { Panel } from './Panel';
import styles from './PredictionPanel.module.css';
import { usePrediction } from './usePrediction';

interface PredictionPanelProps {
  /** From `predictionTarget`: the live game, else the next one. `null` when there is none. */
  game: Game | null;
  /** The team whose page this is, so its side is shown first. */
  team: { providerTeamId: string; name: string };
}

/**
 * §12, §46 — the provider's matchup prediction for the current or next game,
 * with its source named. Every way of having no prediction says
 * "Prediction unavailable" and then why, in words. Nothing here computes a
 * percentage, substitutes betting odds, or fills a gap.
 */
export function PredictionPanel({ game, team }: PredictionPanelProps) {
  const query = usePrediction(game?.providerGameId ?? null);

  let body: ReactNode;
  if (game === null) {
    body = <Unavailable reason="There's no upcoming game to predict." />;
  } else if (query.data === undefined) {
    body = query.isError ? (
      <Unavailable
        reason="The prediction couldn't be loaded. It will try again shortly."
        requestId={isApiError(query.error) ? query.error.requestId : null}
      />
    ) : (
      <div role="status" className={styles.loading}>
        <span className="visually-hidden">Loading prediction…</span>
        <Skeleton height="1rem" width="70%" />
        <Skeleton height="0.75rem" />
      </div>
    );
  } else {
    const { data, error, freshness } = query.data.prediction;
    const view = data === null ? null : predictionView(data, game, team);
    if (error !== null) {
      body = (
        <Unavailable reason="Sports data temporarily unavailable." requestId={error.requestId} />
      );
    } else if (data === null) {
      body = <Unavailable reason="No prediction has been published for this game." />;
    } else if (view === null) {
      body = <Unavailable reason="The prediction for this game couldn't be read." />;
    } else {
      body = (
        <>
          <Split sides={view.sides} />
          {game.status === 'live' && (
            <p className={styles.note}>
              Pregame prediction, made before kickoff. It does not change during the game.
            </p>
          )}
          <p className={styles.source}>Source: {data.sourceLabel}</p>
          {freshness.state === 'stale' && <FreshnessLabel fetchedAt={freshness.fetchedAt} stale />}
        </>
      );
    }
  }

  return (
    <Panel title="Matchup prediction" className={styles.panel}>
      {game !== null && <Matchup game={game} />}
      {body}
    </Panel>
  );
}

/** Which game the numbers are about. */
function Matchup({ game }: { game: Game }) {
  return (
    <p className={styles.matchup}>
      <Opponent game={game} />{' '}
      <span className={styles.when}>
        {game.status === 'live' ? (
          'In progress'
        ) : (
          <time dateTime={game.kickoffUtc}>{formatKickoff(game)}</time>
        )}
      </span>
    </p>
  );
}

/**
 * The two sides as text first (read in full by a screen reader), then one
 * bar split between them, which only repeats the numbers and is hidden from
 * assistive tech.
 */
function Split({ sides }: { sides: [PredictionSideView, PredictionSideView] }) {
  const [first, second] = sides;
  return (
    <div className={styles.split}>
      <ul className={styles.sides} role="list">
        {sides.map((side, index) => (
          <li key={index} className={cx(styles.side, side.ours && styles.ours)}>
            <span className={styles.name}>{side.name}</span>{' '}
            <span className={styles.pct}>{formatPercent(side.pct)}</span>
            <span className="visually-hidden"> chance to win</span>
          </li>
        ))}
      </ul>
      <div
        className={styles.bar}
        aria-hidden="true"
        style={cssVars({ '--first': `${String(first.share)}%` })}
      >
        <span className={cx(styles.segment, first.ours ? styles.oursFill : styles.theirsFill)} />
        <span className={cx(styles.segment, second.ours ? styles.oursFill : styles.theirsFill)} />
      </div>
    </div>
  );
}

function Unavailable({ reason, requestId = null }: { reason: string; requestId?: string | null }) {
  return (
    <div className={styles.unavailable}>
      <p className={styles.unavailableTitle}>Prediction unavailable</p>
      <p className={styles.reason}>{reason}</p>
      {requestId !== null && <p className={styles.reference}>Reference: {requestId}</p>}
    </div>
  );
}
