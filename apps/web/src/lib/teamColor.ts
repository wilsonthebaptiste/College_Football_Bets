/**
 * §35 — a team's colour appears as one 4 px rule on its card, nothing more.
 *
 * Provider colours arrive as bare hex and are sometimes useless against the
 * card: a white primary vanishes on a light card, a near-black one on a dark
 * card. So each theme gets its own pick: the primary if it shows up, then the
 * alternate, then nothing (the card keeps its neutral rule).
 */

const HEX = /^[0-9a-f]{6}$/i;

/** WCAG relative luminance of a bare 6-digit hex colour. */
export function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** Too pale to see on a white card. */
const LIGHT_THEME_MAX = 0.75;
/** Too dark to see on the dark card. */
const DARK_THEME_MIN = 0.03;

function pick(candidates: readonly (string | null)[], visible: (l: number) => boolean) {
  for (const candidate of candidates) {
    if (candidate !== null && HEX.test(candidate) && visible(luminance(candidate))) {
      return `#${candidate.toLowerCase()}`;
    }
  }
  return null;
}

export interface TeamAccent {
  light: string | null;
  dark: string | null;
}

export function teamAccent(primary: string | null, alt: string | null): TeamAccent {
  const candidates = [primary, alt];
  return {
    light: pick(candidates, (l) => l <= LIGHT_THEME_MAX),
    dark: pick(candidates, (l) => l >= DARK_THEME_MIN),
  };
}
