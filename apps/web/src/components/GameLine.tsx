import type { Game, GameResult, HomeAway, NextGameSlot } from '@cfb/shared';
import { cx } from '../lib/cx';
import { formatGameDate, formatKickoff, formatScore, statusLabel } from '../lib/format';
import styles from './GameLine.module.css';

/**
 * One game, told from the viewed team's side: who they play, where, when, and
 * how it went. Shared by the board cards and the team page (§9, §10, §19).
 */

/** §19 — from the provider's designation, never inferred. `@` is read aloud as "at". */
export function HomeAwayMark({ homeAway }: { homeAway: HomeAway }) {
  const away = homeAway === 'away';
  return (
    <span className={styles.homeAway}>
      <span aria-hidden="true">{away ? '@' : 'vs'}</span>
      <span className="visually-hidden">{away ? 'at' : 'versus'}</span>
    </span>
  );
}

export function Opponent({ game }: { game: Game }) {
  return (
    <span className={styles.opponent}>
      <HomeAwayMark homeAway={game.homeAway} />{' '}
      <span className={styles.opponentName}>{game.opponent.name}</span>
      {game.homeAway === 'neutral' && <span className={styles.neutral}> (neutral site)</span>}
    </span>
  );
}

const RESULT_WORDS: Record<GameResult, string> = { W: 'Won', L: 'Lost', T: 'Tied' };
const RESULT_CLASS: Record<GameResult, string | undefined> = {
  W: styles.win,
  L: styles.loss,
  T: styles.tie,
};

/** `W 31–24`. The letter carries the result; colour only repeats it (§48). */
export function GameResultText({ game }: { game: Game }) {
  if (game.result === null) {
    const label = statusLabel(game);
    return label === null ? null : <StatusTag>{label}</StatusTag>;
  }
  const hasScore = game.teamScore !== null && game.opponentScore !== null;
  return (
    <span className={styles.result}>
      <span className={cx(styles.resultLetter, RESULT_CLASS[game.result])} aria-hidden="true">
        {game.result}
      </span>
      <span className="visually-hidden">{RESULT_WORDS[game.result]}</span>
      {hasScore && (
        <span className={styles.score}>
          {' '}
          {formatScore(game.teamScore ?? 0, game.opponentScore ?? 0)}
        </span>
      )}
    </span>
  );
}

export function StatusTag({ children }: { children: string }) {
  return <span className={styles.statusTag}>{children}</span>;
}

/** §9 — the latest final game, or a plain statement that there is none yet. */
export function PreviousGameLine({ game }: { game: Game | null }) {
  if (game === null) return <span className={styles.none}>No games played yet</span>;
  return (
    <span className={styles.line}>
      <Opponent game={game} /> <GameResultText game={game} />
    </span>
  );
}

function UpcomingGame({ game }: { game: Game }) {
  const label = statusLabel(game);
  return (
    <span className={styles.stack}>
      <span className={styles.line}>
        <Opponent game={game} />
        {label !== null && (
          <>
            {' '}
            <StatusTag>{label}</StatusTag>
          </>
        )}
      </span>{' '}
      <time className={styles.when} dateTime={game.kickoffUtc}>
        {formatKickoff(game)}
      </time>
    </span>
  );
}

/**
 * §10 — the next game, or one of the three ways there isn't one. A bye still
 * names the game after it, so the card says what is coming as well as what
 * isn't.
 */
export function NextGameLine({ slot }: { slot: NextGameSlot }) {
  switch (slot.kind) {
    case 'game':
      return <UpcomingGame game={slot.game} />;
    case 'bye':
      return (
        <span className={styles.stack}>
          <span className={styles.bye}>
            Bye week{slot.week === null ? '' : ` (week ${String(slot.week)})`}
          </span>
          {slot.following !== null && (
            <span className={styles.when}>
              Then <Opponent game={slot.following} />,{' '}
              <time dateTime={slot.following.kickoffUtc}>{formatKickoff(slot.following)}</time>
            </span>
          )}
        </span>
      );
    case 'none':
      return (
        <span className={styles.none}>
          {slot.reason === 'season_complete' ? 'Season complete' : 'No upcoming game'}
        </span>
      );
  }
}

/** The team page's fuller telling of one game: date, venue, and broadcast when known. */
export function GameFacts({ game, played }: { game: Game; played: boolean }) {
  const facts = [
    played ? formatGameDate(game) : null,
    game.venue,
    game.broadcast === null ? null : `TV: ${game.broadcast}`,
  ].filter((fact): fact is string => fact !== null && fact.trim() !== '');
  if (facts.length === 0) return null;
  return (
    <ul className={styles.facts} role="list">
      {facts.map((fact) => (
        <li key={fact}>{fact}</li>
      ))}
    </ul>
  );
}
