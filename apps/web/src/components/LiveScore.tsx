import type { Game } from '@cfb/shared';
import { cx } from '../lib/cx';
import { liveSituation } from '../lib/format';
import { HomeAwayMark } from './GameLine';
import { LiveBadge } from './LiveBadge';
import styles from './LiveScore.module.css';

interface LiveScoreProps {
  game: Game;
  /** The viewed team's short name, for its side of the scoreboard. */
  teamName: string;
  size?: 'card' | 'page';
}

/**
 * §11 — a game in progress, shown ahead of everything else on the card.
 *
 * Only the score is a live region, so a screen reader hears the score when it
 * changes and not the clock on every poll (plan §9). A live game with no score
 * (its scoreboard could not be fetched) says so in words rather than showing
 * 0–0, which would be fabricated (§4).
 */
export function LiveScore({ game, teamName, size = 'card' }: LiveScoreProps) {
  const hasScore = game.teamScore !== null && game.opponentScore !== null;
  return (
    <section className={cx(styles.live, styles[size])} aria-label={`${teamName} live game`}>
      <div className={styles.head}>
        <LiveBadge />
        <span className={styles.situation}>{liveSituation(game)}</span>
      </div>
      <div className={styles.board} aria-live="polite" aria-atomic="true">
        {hasScore ? (
          <>
            <p className={styles.side}>
              <span className={styles.name}>{teamName}</span>
              <span className={styles.points}>{String(game.teamScore)}</span>
            </p>
            <p className={styles.side}>
              <span className={styles.name}>
                <HomeAwayMark homeAway={game.homeAway} /> {game.opponent.name}
              </span>
              <span className={styles.points}>{String(game.opponentScore)}</span>
            </p>
          </>
        ) : (
          <p className={styles.noScore}>
            {teamName} <HomeAwayMark homeAway={game.homeAway} /> {game.opponent.name}: score
            unavailable
          </p>
        )}
      </div>
    </section>
  );
}
