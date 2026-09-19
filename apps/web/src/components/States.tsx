import type { ReactNode } from 'react';
import styles from './States.module.css';

interface StateProps {
  title: string;
  message?: ReactNode;
  action?: ReactNode;
}

/** Nothing to show, and nothing wrong: an empty board, an empty list. */
export function EmptyState({ title, message, action }: StateProps) {
  return (
    <div className={styles.state}>
      <h2 className={styles.title}>{title}</h2>
      {message !== undefined && <p className={styles.message}>{message}</p>}
      {action !== undefined && <div className={styles.action}>{action}</div>}
    </div>
  );
}

interface ErrorStateProps extends StateProps {
  /** The failing response's `X-Request-Id`, so a failure can be matched to its log line. */
  requestId?: string | null;
  /** `h1` when the error IS the page (so the page still has its one heading). */
  headingLevel?: 1 | 2;
}

/** Something failed. Says what, and what to do about it (§38). */
export function ErrorState({
  title,
  message,
  action,
  requestId = null,
  headingLevel = 1,
}: ErrorStateProps) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
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
