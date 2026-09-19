import { cx } from '../lib/cx';
import { formatUpdatedAt } from '../lib/format';
import { ClockAlertIcon } from './icons';
import styles from './FreshnessLabel.module.css';

interface FreshnessLabelProps {
  /** When the provider produced the data (never when it was last read). */
  fetchedAt: string | null;
  /** `stale` changes the label's words, icon, and colour (§23, §39). */
  stale: boolean;
  className?: string | undefined;
}

/**
 * `Last updated: 3:42 PM` (§23), or, for stale data, a warning that says in
 * words that it may be out of date. Renders nothing when there is no
 * timestamp: an empty label is better than an invented one.
 */
export function FreshnessLabel({ fetchedAt, stale, className }: FreshnessLabelProps) {
  const updated = formatUpdatedAt(fetchedAt);
  if (updated === null || fetchedAt === null) return null;

  if (stale) {
    return (
      <p className={cx(styles.label, styles.stale, className)}>
        <ClockAlertIcon className={styles.icon} />
        <span>
          May be out of date. Last updated: <time dateTime={fetchedAt}>{updated}</time>
        </span>
      </p>
    );
  }
  return (
    <p className={cx(styles.label, className)}>
      Last updated: <time dateTime={fetchedAt}>{updated}</time>
    </p>
  );
}
