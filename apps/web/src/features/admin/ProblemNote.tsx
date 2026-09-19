import { useEffect, useRef } from 'react';
import styles from './Admin.module.css';
import type { Problem } from './useAdminWrite';

/**
 * A write the server refused, said plainly, with the request id that matches
 * its log line (§38). Focus moves here so a keyboard or screen-reader user
 * learns the change did not happen.
 */
export function ProblemNote({ problem, onDismiss }: { problem: Problem; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [problem]);

  return (
    <div className={styles.problem} role="alert" tabIndex={-1} ref={ref}>
      <p>
        <strong>That didn't work.</strong> {problem.message}
      </p>
      {problem.requestId !== null && (
        <p className={styles.reference}>Reference: {problem.requestId}</p>
      )}
      <button type="button" className="button-quiet" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
