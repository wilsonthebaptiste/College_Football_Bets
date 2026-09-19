import type { MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronLeftIcon } from './icons';
import styles from './BackLink.module.css';

/**
 * Where a page came from, carried in router state (plan §3: a team page is not
 * owned by a board, so its URL does not say which board led to it).
 */
export interface FromState {
  from: { path: string; label: string };
}

export function readFromState(state: unknown): FromState['from'] | null {
  if (typeof state !== 'object' || state === null || !('from' in state)) return null;
  const from: unknown = state.from;
  if (typeof from !== 'object' || from === null) return null;
  const { path, label } = from as Record<string, unknown>;
  // Only an in-app path: router state is not a place to smuggle in a URL.
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
  if (typeof label !== 'string' || label === '') return null;
  return { path, label };
}

interface BackLinkProps {
  to: string;
  label: string;
  /**
   * True when `to` is the previous history entry. The click then goes BACK
   * rather than pushing a new entry, so the browser's own back button keeps
   * working as expected afterwards (§47), and the board keeps its scroll.
   */
  isHistoryBack?: boolean;
}

export function BackLink({ to, label, isHistoryBack = false }: BackLinkProps) {
  const navigate = useNavigate();

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const plainClick =
      event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (!isHistoryBack || !plainClick) return;
    event.preventDefault();
    void navigate(-1);
  };

  return (
    <Link className={styles.back} to={to} onClick={onClick}>
      <ChevronLeftIcon />
      {label}
    </Link>
  );
}
