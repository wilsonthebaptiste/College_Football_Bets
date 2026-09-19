import type { GameResult } from '@cfb/shared';
import { cx } from '../lib/cx';
import styles from './ResultMark.module.css';

const WORDS: Record<GameResult, string> = { W: 'Won', L: 'Lost', T: 'Tied' };
const SHAPES: Record<GameResult, string | undefined> = {
  W: styles.win,
  L: styles.loss,
  T: styles.tie,
};

/**
 * §17, §48 — a result told three ways: the letter, the word (for screen
 * readers), and a shape. A win is a solid tile, a loss an outlined one, and a
 * tie a dashed one, so the column reads correctly in greyscale, to a
 * colour-blind viewer, and in either theme. Colour only repeats it.
 */
export function ResultMark({ result }: { result: GameResult }) {
  return (
    <>
      <span className={cx(styles.mark, SHAPES[result])} aria-hidden="true">
        {result}
      </span>
      <span className="visually-hidden">{WORDS[result]}</span>
    </>
  );
}
