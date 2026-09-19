import type { ReactNode } from 'react';
import { Card } from '../../components/Card';
import { cx } from '../../lib/cx';
import styles from './Panel.module.css';

interface PanelProps {
  title: string;
  /** Beside the title, on the right: a season label, a count. */
  aside?: ReactNode;
  /** Stale data changes the panel's outline as well as its words (§23, §39). */
  stale?: boolean;
  className?: string | undefined;
  children: ReactNode;
}

/**
 * One section of the team page. Each loads and fails on its own (§42), so
 * each is its own titled panel rather than a region of one big card.
 */
export function Panel({ title, aside, stale = false, className, children }: PanelProps) {
  return (
    <Card as="section" stale={stale} className={cx(styles.panel, className)}>
      <div className={styles.head}>
        <h2 className={styles.title}>{title}</h2>
        {aside}
      </div>
      {children}
    </Card>
  );
}
