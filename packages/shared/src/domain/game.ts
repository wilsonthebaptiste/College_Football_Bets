import type { Season } from '../season';
import type { TeamRef } from './team';

/**
 * §18 — provider status vocabularies are normalized into exactly these.
 *
 * `'unknown'` is load-bearing: ESPN can and does emit status strings we have
 * never seen, and §40 requires that an unexpected value degrade to a neutral
 * render rather than crash. Anything unrecognized lands here and is logged once.
 */
export type GameStatus =
  'scheduled' | 'live' | 'final' | 'postponed' | 'canceled' | 'delayed' | 'suspended' | 'unknown';

/** §19 — taken from the provider's own designation, never inferred from ordering. */
export type HomeAway = 'home' | 'away' | 'neutral';

export type GameResult = 'W' | 'L' | 'T';

/**
 * One game, always from the perspective of the team whose board or page is being
 * viewed — hence `teamScore`/`opponentScore` rather than `homeScore`/`awayScore`.
 *
 * INVARIANT, enforced in `normalize.ts` and asserted in tests:
 *   `result !== null`  ⟺  `status === 'final'`
 * §11 forbids presenting live information as final, and §9 forbids confusing the
 * previous game with a live one. Both follow from that single invariant.
 */
export interface Game {
  providerGameId: string;
  season: Season;
  week: number | null;

  /** §20 — ISO 8601 UTC. A formatted string like "4:30 PM" never enters the model. */
  kickoffUtc: string;
  /**
   * True when the provider has a date but no confirmed kickoff time ("TBD").
   * The time part of `kickoffUtc` is then a placeholder (ESPN uses midnight
   * Eastern), so the UI must render the date alone. Showing "9:00 PM" for a
   * game with no announced time would be fabricated sports data (§4).
   */
  kickoffTbd: boolean;

  status: GameStatus;
  /** The provider's own wording: "3rd Quarter", "Final/OT", "Postponed". */
  statusDetail: string | null;
  /** §11 — live only. Quarter number and game clock. */
  period: number | null;
  clock: string | null;

  homeAway: HomeAway;
  opponent: TeamRef;

  teamScore: number | null;
  opponentScore: number | null;
  result: GameResult | null;

  venue: string | null;
  broadcast: string | null;
}

/**
 * §10 — "no next game" has three distinct meanings and the UI says something
 * different for each. A bare `Game | null` cannot tell them apart.
 *
 * `bye.following` is the first game after the bye, so a card can say "Bye
 * week" without hiding the next opponent (§10 asks for both).
 */
export type NextGameSlot =
  | { kind: 'game'; game: Game }
  | { kind: 'bye'; week: number | null; following: Game | null }
  | { kind: 'none'; reason: 'season_complete' | 'no_upcoming' };

/** A row of the full-season schedule (§17). Bye weeks are rows, not gaps. */
export type ScheduleItem = { kind: 'game'; game: Game } | { kind: 'bye'; week: number | null };

export interface ScheduleResult {
  season: Season;
  items: ScheduleItem[];
}

/** Typed guard for the invariant above; used by normalizers and tests. */
export function isFinal(game: Game): boolean {
  return game.status === 'final';
}

export function isLive(game: Game): boolean {
  return game.status === 'live';
}
