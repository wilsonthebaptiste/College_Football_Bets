import { useState } from 'react';
import { cssVars } from '../lib/cx';
import { initials } from '../lib/format';
import styles from './TeamLogo.module.css';

interface TeamLogoProps {
  src: string | null;
  /** The team's name, for the alt text and the initials. */
  name: string;
  abbreviation: string | null;
  /** Square size in CSS pixels. Set on the element, so nothing shifts while it loads. */
  size: number;
  /**
   * The team's name is printed right beside it (a schedule row), so the logo
   * is hidden from assistive tech rather than read out as "LSU logo, LSU".
   */
  decorative?: boolean;
}

/**
 * §36 — a logo with alt text, and a fallback that can never break the card: a
 * missing URL, or one that fails to load, becomes the team's initials in a
 * neutral circle, labelled exactly as the image would have been.
 */
export function TeamLogo({ src, name, abbreviation, size, decorative = false }: TeamLogoProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const label = `${name} logo`;

  if (src !== null && src !== '' && src !== failedSrc) {
    return (
      <img
        className={styles.logo}
        src={src}
        alt={decorative ? '' : label}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setFailedSrc(src)}
      />
    );
  }

  return (
    <span
      className={styles.fallback}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
      style={cssVars({ '--logo-size': `${String(size)}px` })}
    >
      <span aria-hidden="true">{initials(name, abbreviation)}</span>
    </span>
  );
}
