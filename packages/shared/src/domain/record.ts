/**
 * §8 — "If ties or other record components are supplied by the sports provider,
 * the application should preserve them accurately."
 *
 * Hence both representations. `summary` is the provider's own string, displayed
 * verbatim, which is how oddities survive: ties ("7-4-1"), vacated wins, and
 * overtime bookkeeping that no parse of ours would round-trip correctly.
 * The parsed parts exist for sorting and comparison, not for display.
 */
export interface TeamRecord {
  wins: number;
  losses: number;
  /** `null` when the provider does not report ties at all — not the same as zero. */
  ties: number | null;
  /** The provider's own string. Render THIS, not a reconstruction of it. */
  summary: string;
  conference: ConferenceRecord | null;
}

export interface ConferenceRecord {
  wins: number;
  losses: number;
}
