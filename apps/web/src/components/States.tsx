import type { ReactNode } from 'react';
import styles from './States.module.css';

interface StateProps {
  title: string;
  message?: ReactNode;
  action?: ReactNode;
  /** `h1` when the state IS the page (so the page still has its one heading); `h3` inside a section. */
  headingLevel?: 1 | 2 | 3;
}

const HEADINGS = { 1: 'h1', 2: 'h2', 3: 'h3' } as const;

/** Nothing to show, and nothing wrong: an empty board, an empty list. */
export function EmptyState({ title, message, action, headingLevel = 2 }: StateProps) {
  const Heading = HEADINGS[headingLevel];
  return (
    <div className={styles.state}>
      <Heading className={styles.title}>{title}</Heading>
      {message !== undefined && <p className={styles.message}>{message}</p>}
      {action !== undefined && <div className={styles.action}>{action}</div>}
    </div>
  );
}

interface ErrorStateProps extends StateProps {
  /** The failing response's `X-Request-Id`, so a failure can be matched to its log line. */
  requestId?: string | null;
}

/** Something failed. Says what, and what to do about it (§38). */
export function ErrorState({
  title,
  message,
  action,
  requestId = null,
  headingLevel = 1,
}: ErrorStateProps) {
  const Heading = HEADINGS[headingLevel];
  return (
    <div className={styles.state} role="alert">
      <Heading className={styles.title}>{title}</Heading>
      {message !== undefined && <p className={styles.message}>{message}</p>}
      {action !== undefined && <div className={styles.action}>{action}</div>}
      {requestId !== null && <p className={styles.reference}>Reference: {requestId}</p>}
    </div>
  );
}

/** A short "working on it" line for waits too brief or too simple for a skeleton. */
export function LoadingNote({ children }: { children: string }) {
  return (
    <p className={styles.loading} role="status">
      {children}
    </p>
  );
}
