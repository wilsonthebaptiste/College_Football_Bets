import type { BoardResponse, Envelope, Game, TeamSnapshot } from '@cfb/shared';

/**
 * §24 — every refresh interval in the app, in one place.
 *
 * The first two match the Worker's own board TTLs (plan §7: 15 s while a team
 * is live, 60 s otherwise). Polling faster than the server refreshes would only
 * re-read its cache; `Cache-Control` lets the browser absorb those repeats.
 */
export const POLL = {
  /** A team on the board is playing. */
  liveMs: 15_000,
  /** A game is coming up soon, or a card is failing or stale and should recover quickly. */
  activeMs: 60_000,
  /** Nothing is happening: "avoid aggressive refreshes when no games are occurring". */
  idleMs: 5 * 60_000,
  /**
   * Data younger than this is not refetched on window focus or remount. It is
   * what stops a 15 s interval plus tab switching from turning into a storm.
   */
  staleTimeMs: 10_000,
  /** How far ahead a kickoff makes the board "active" rather than idle. */
  gameSoonMs: 12 * 60 * 60_000,
} as const;

/** The game a snapshot is waiting on: the next game, or the one after a bye. */
function upcomingGame(snapshot: TeamSnapshot): Game | null {
  const slot = snapshot.nextGame;
  if (slot.kind === 'game') return slot.game;
  if (slot.kind === 'bye') return slot.following;
  return null;
}

/**
 * The interval for a set of team snapshots (a board, or one team's page).
 *
 * - Anything live → `liveMs`.
 * - A kickoff within `gameSoonMs` (or one already past but not yet reported
 *   live), or any card with no data or stale data → `activeMs`.
 * - Otherwise → `idleMs`.
 *
 * A TBD kickoff's time is a placeholder, so it never makes a board active.
 */
export function pollIntervalFor(snapshots: readonly Envelope<TeamSnapshot>[], now: number): number {
  let active = false;
  for (const envelope of snapshots) {
    const snapshot = envelope.data;
    if (snapshot === null || envelope.freshness.state === 'stale') {
      active = true;
      continue;
    }
    if (snapshot.liveGame !== null) return POLL.liveMs;

    const next = upcomingGame(snapshot);
    if (next !== null && !next.kickoffTbd) {
      const kickoff = Date.parse(next.kickoffUtc);
      if (!Number.isNaN(kickoff) && kickoff - now <= POLL.gameSoonMs) active = true;
    }
  }
  return active ? POLL.activeMs : POLL.idleMs;
}

/** The board's interval. `anyLive` is the server's word on live games and wins outright. */
export function boardPollInterval(board: BoardResponse, now: number): number {
  if (board.anyLive) return POLL.liveMs;
  return pollIntervalFor(
    board.teams.map((entry) => entry.snapshot),
    now,
  );
}
