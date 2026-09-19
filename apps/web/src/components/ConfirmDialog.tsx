import { useEffect, useId, useRef, type ReactNode } from 'react';
import styles from './ConfirmDialog.module.css';

interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  /** The destructive action's own verb: "Remove", "Delete". Never "OK". */
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  /** Cancel, Escape, or the backdrop. */
  onCancel: () => void;
  /**
   * Where focus goes once the dialog has gone: usually the button that opened
   * it, or something near it if that button went with the change. Asked at
   * that moment, so it can look at the page as it now is.
   */
  returnFocus: () => HTMLElement | null | undefined;
}

/**
 * "Are you sure?" before anything that cannot be undone (plan §5.1: confirm
 * before removal).
 *
 * A native modal `<dialog>`, rendered only while open. The browser supplies
 * what a hand-built one gets wrong: focus is kept inside, the page behind is
 * inert to the keyboard and to screen readers, and Escape cancels. Focus
 * starts on Cancel, the safe choice. Focus afterwards goes where
 * `returnFocus` says, because the button that opened it may be gone by then.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
  returnFocus,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (!dialog.open) dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      // Runs once the dialog has left the page, so the page is no longer inert
      // and the change that closed it has been drawn.
      returnFocusRef.current()?.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onCancel={(event) => {
        // Escape. Let React state close it, so it cannot close without the page knowing.
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the <dialog> itself.
        if (event.target === ref.current) onCancel();
      }}
    >
      <div className={styles.body}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <p id={messageId} className={styles.message}>
          {message}
        </p>
        <div className={styles.actions}>
          <button ref={cancelRef} type="button" className="button-quiet" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`button ${styles.danger}`}
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onConfirm();
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
