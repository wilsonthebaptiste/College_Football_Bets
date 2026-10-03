import type { Game } from '@cfb/shared';
import type { ReactNode } from 'react';
import { FreshnessLabel } from '../../components/FreshnessLabel';
import { Skeleton } from '../../components/Skeleton';
import { isApiError } from '../../lib/apiClient';
import { cssVars, cx } from '../../lib/cx';
import { formatKickoff, formatPercent } from '../../lib/format';
import {
  predictionView,
  type PredictionOrder,
  type PredictionSideView,
} from '../../lib/prediction';
import { Panel } from './Panel';
import styles from './PredictionPanel.module.css';
import { usePrediction } from './usePrediction';

/** The game a prediction is about, and how the page wants its two sides laid out. */
export interface PredictionSubject {
  game: Pick<Game, 'providerGameId' | 'status' | 'kickoffUtc' | 'kickoffTbd'>;
  order: PredictionOrder;
  /**
   * Names the game ahead of its time ("@ Tennessee"). The team page needs it;
   * the matchup page leaves it out, because its own heading already names
   * both teams.
   */
  label?: ReactNode;
}

interface PredictionPanelProps {
  /**
   * The team page passes `predictionTarget`'s game (the live game, else the
   * next one); the matchup page passes its own game while it is not final.
   * `null` when there is nothing to predict.
   */
  subject: PredictionSubject | null;
  /** The panel's heading. The team page's is "Matchup prediction". */
  title?: string;
}

/**
 * §12, §46 — the provider's matchup prediction for the current or next game,
 * with its source named. Every way of having no prediction says
 * "Prediction unavailable" and then why, in words. Nothing here computes a
 * percentage, substitutes betting odds, or fills a gap.
 *
 * Shared by the team page and the matchup page (plan-matchup-board, Phase 2).
 * The only difference between them is `order`: which side is listed first, and
 * whether one of them is the page's own team. Everything the panel SAYS is
 * written once, here, so the pregame caveat and the source line cannot drift
 * between the two pages.
 */
export function PredictionPanel({ subject, title = 'Matchup prediction' }: PredictionPanelProps) {
  const game = subject?.game ?? null;
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
    const view =
      data === null || subject === null
        ? null
        : predictionView(data, game.providerGameId, subject.order);
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
    <Panel title={title} className={styles.panel}>
      {subject !== null && <Matchup subject={subject} />}
      {body}
    </Panel>
  );
}

/** Which game the numbers are about, and when. */
function Matchup({ subject }: { subject: PredictionSubject }) {
  const { game, label } = subject;
  return (
    <p className={styles.matchup}>
      {label !== undefined && <>{label} </>}
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
  // On a page that views neither team, neither is "ours": two neutral tones,
  // so the bar does not seem to favour whichever side the accent lands on.
  const neutral = !first.ours && !second.ours;
  const fill = (side: PredictionSideView, index: number): string | undefined =>
    side.ours ? styles.oursFill : neutral && index === 0 ? styles.neutralFill : styles.theirsFill;
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
        <span className={cx(styles.segment, fill(first, 0))} />
        <span className={cx(styles.segment, fill(second, 1))} />
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
