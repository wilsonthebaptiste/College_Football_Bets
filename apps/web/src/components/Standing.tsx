import type { RankingState, TeamRecord } from '@cfb/shared';
import { cx } from '../lib/cx';
import styles from './Standing.module.css';

type Size = 'lg' | 'md';

/**
 * §7 — three states, three renders, never confused:
 *
 *   ranked      → `#4`
 *   unranked    → `NR`
 *   unavailable → `—`  (a failed lookup is not evidence the team is unranked)
 *
 * The poll's name goes to assistive tech and the tooltip; the board header
 * shows it once for every card.
 */
export function RankBadge({ ranking, size = 'lg' }: { ranking: RankingState; size?: Size }) {
  const className = cx(styles.rank, styles[size]);
  switch (ranking.kind) {
    case 'ranked':
      return (
        <span className={className} title={ranking.poll}>
          <span className="visually-hidden">Ranked </span>
          <span aria-hidden="true">#</span>
          {String(ranking.rank)}
          <span className="visually-hidden"> in the {ranking.poll}</span>
        </span>
      );
    case 'unranked':
      return (
        <span className={cx(className, styles.quiet)} title="Not ranked">
          <span aria-hidden="true">NR</span>
          <span className="visually-hidden">Not ranked</span>
        </span>
      );
    case 'unavailable':
      return (
        <span className={cx(className, styles.quiet)} title="Ranking unavailable">
          <span aria-hidden="true">—</span>
          <span className="visually-hidden">Ranking unavailable</span>
        </span>
      );
  }
}

/**
 * §8 — the provider's own record string, verbatim, so ties and oddities
 * survive. `null` means nothing is known yet, shown as `—`.
 */
export function RecordBadge({ record, size = 'md' }: { record: TeamRecord | null; size?: Size }) {
  const className = cx(styles.record, styles[size]);
  if (record === null || record.summary.trim() === '') {
    return (
      <span className={cx(className, styles.quiet)} title="Record unavailable">
        <span aria-hidden="true">—</span>
        <span className="visually-hidden">Record unavailable</span>
      </span>
    );
  }
  return (
    <span className={className}>
      <span className="visually-hidden">Record </span>
      {record.summary}
    </span>
  );
}
