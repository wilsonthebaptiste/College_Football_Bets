import styles from './LiveBadge.module.css';

/** §11, §48 — the word LIVE carries the state; the colour and the dot only repeat it. */
export function LiveBadge() {
  return (
    <span className={styles.badge}>
      <span className={styles.dot} aria-hidden="true" />
      LIVE
    </span>
  );
}
