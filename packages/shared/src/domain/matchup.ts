import type { Freshness } from '../envelope';
import type { Season } from '../season';
import type { GameStatus } from './game';
import type { RankingState } from './ranking';
import type { TeamRecord } from './record';
import type { PageTeam } from './team';

/**
 * The matchup board (context/plan-matchup-board.md): every game in a week
 * where a team on one board plays a team on another.
 *
 * Nothing here is stored. A matchup is derived on every read from the week's
 * games and the boards' picks (§45), so there is no matchup id of our own: a
 * matchup is addressed by the provider's game id, as `/api/games/:gameId` is.
 */

/**
 * One week of the provider's calendar, for navigation.
 *
 * `week` is the provider's own number for it, which is what `?week=` takes.
 * In the regular season that is 1, 2, 3…; in the postseason it is whatever
 * the provider numbers its rounds (ESPN: `1` for the bowls, `999` for the
 * playoff), so a client prints `label`, never "Week {week}".
 */
export interface SeasonWeek {
  week: number;
  /** The provider's own label: "Week 6", "Bowls", "CFP". */
  label: string;
  /** ISO 8601 UTC. The window the provider files the week's games under. */
  startUtc: string;
  endUtc: string;
}

/** Someone whose board holds a team. The same shape as the pick index's `TeamOwner`. */
export interface MatchupOwner {
  userId: string;
  displayName: string;
}

/** One side of a matchup: a team, who has it, and what the provider says about it. */
export interface MatchupSide {
  /**
   * Identity from Postgres for a team somebody has (§45), so `id` is our uuid.
   * Only `GET /api/matchups/:gameId` can return a side nobody has, and that
   * side's identity is the provider's, with `id: null`.
   */
  team: PageTeam;
  /** Sorted by display name. Empty only for a side nobody has (single-game read). */
  owners: MatchupOwner[];
  /**
   * From the application's rankings read (CFP, else AP), not the provider's
   * per-game rank, so this agrees with every board card on the same screen.
   * `unavailable` (—) is not `unranked` (NR).
   */
  ranking: RankingState;
  /** The provider's record for the team, verbatim in `summary`. `null` when it sent none. */
  record: TeamRecord | null;
  /** `null` unless the game is live or final. A postponed "0" is not a score. */
  score: number | null;
  /** `null` unless the provider says the game is final. */
  winner: boolean | null;
}

/**
 * One game between boards, from neither team's point of view: home and away,
 * as the provider designates them (§19), with `neutralSite` deciding between
 * "at" and "vs".
 *
 * INVARIANT, inherited from `ProviderGame`: `winner !== null` on either side
 * only when `status === 'final'`.
 */
export interface Matchup {
  providerGameId: string;
  season: Season;
  week: number | null;
  /** §20 — ISO 8601 UTC. */
  kickoffUtc: string;
  /** The time part of `kickoffUtc` is a placeholder; render the date alone. */
  kickoffTbd: boolean;
  status: GameStatus;
  /** The provider's own wording, never repeated as "Final" while the game is live. */
  statusDetail: string | null;
  period: number | null;
  clock: string | null;
  neutralSite: boolean;
  venue: string | null;
  broadcast: string | null;
  home: MatchupSide;
  away: MatchupSide;
  /** One person has both sides ("Wilson vs Wilson"). It happens most weeks. */
  sameOwner: boolean;
  /**
   * When the status, score, and clock on this row were read from the provider.
   * For a game in its live window that is the live slate's read, which can be
   * newer than the week document the rest of the row came from; otherwise it
   * is the week document's. `null` only when neither has a time.
   */
  scoreUpdatedAt: string | null;
  /**
   * This row's own freshness. A live row's is the live slate's (its score,
   * clock, and status came from there); every other row's is the week
   * document's. A row whose live game could not be checked against the slate
   * is `stale`, with the week document's original time.
   */
  freshness: Freshness;
}
