import type { ReactNode } from 'react';
import { cssVars, cx } from '../lib/cx';
import type { TeamAccent } from '../lib/teamColor';
import styles from './Card.module.css';

interface CardProps {
  as?: 'article' | 'section' | 'div';
  /**
   * A team's colour, drawn as the card's 4 px left rule and nowhere else (§35).
   * A team card always passes one, even if both colours are unusable, so it
   * keeps the rule in a neutral tone. Other cards leave it out and get a plain
   * border.
   */
  accent?: TeamAccent | null;
  /** Stale data changes the card's outline as well as its text (§23, §39). */
  stale?: boolean;
  className?: string | undefined;
  children: ReactNode;
}

export function Card({
  as: Tag = 'div',
  accent = null,
  stale = false,
  className,
  children,
}: CardProps) {
  return (
    <Tag
      className={cx(styles.card, accent === null && styles.plain, stale && styles.stale, className)}
      style={
        accent === null
          ? undefined
          : cssVars({ '--team-light': accent.light, '--team-dark': accent.dark })
      }
    >
      {children}
    </Tag>
  );
}
