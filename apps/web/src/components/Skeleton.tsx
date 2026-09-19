import { cssVars, cx } from '../lib/cx';
import styles from './Skeleton.module.css';

interface SkeletonProps {
  width?: string;
  height?: string;
  round?: boolean;
  className?: string | undefined;
}

/**
 * A placeholder block for the first load only (§37). Hidden from assistive
 * tech: the surrounding region announces "Loading…" once instead.
 */
export function Skeleton({
  width = '100%',
  height = '1em',
  round = false,
  className,
}: SkeletonProps) {
  return (
    <span
      className={cx(styles.block, round && styles.round, className)}
      style={cssVars({ '--sk-width': width, '--sk-height': height })}
      aria-hidden="true"
    />
  );
}
