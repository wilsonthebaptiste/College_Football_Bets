import type { Season } from '../season';

/**
 * §7 — three genuinely different states, and the UI renders each differently:
 *
 *   ranked      → `#4`
 *   unranked    → `NR`  (we know the team is not ranked)
 *   unavailable → `—`   (we do not know anything; NEVER render this as `NR`)
 *
 * Collapsing the last two into `null` is the bug this type exists to prevent —
 * it would have the application assert "not ranked" on the strength of a failed
 * request, which is fabricating sports information (§4).
 */
export type RankingState =
  | { kind: 'ranked'; rank: number; poll: string; week: number | null }
  | { kind: 'unranked' }
  | { kind: 'unavailable' };

export interface RankedTeam {
  rank: number;
  providerTeamId: string;
  name: string;
  abbreviation: string | null;
  /** The provider's record string for the team at the time of the poll. */
  recordSummary: string | null;
}

export interface RankingsSnapshot {
  season: Season;
  /** e.g. "CFP Rankings" or "AP Top 25". Always displayed, never inferred (§7). */
  poll: string;
  week: number | null;
  teams: RankedTeam[];
}
