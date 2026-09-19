import type { BoardResponse } from '@cfb/shared';

/**
 * The board header's honest "last updated" (plan, Phase 2 notes for Phase 3).
 *
 * The board-level `freshness` only records when the board was ASSEMBLED, which
 * can be seconds ago even while a card is showing data from an hour back. So
 * the header reports the OLDEST card's `fetchedAt` instead, and flags the board
 * if any card is stale (§23, §39: stale must never pass for current).
 */
export interface BoardFreshness {
  /** The oldest `fetchedAt` among cards that have data. `null` if none do. */
  oldestFetchedAt: string | null;
  /** At least one card is showing cached data past its lifetime. */
  anyStale: boolean;
  /** Cards with nothing to show. */
  unavailableCount: number;
}

export function summarizeBoardFreshness(board: Pick<BoardResponse, 'teams'>): BoardFreshness {
  let oldest: { iso: string; ms: number } | null = null;
  let anyStale = false;
  let unavailableCount = 0;

  for (const { snapshot } of board.teams) {
    const { state, fetchedAt } = snapshot.freshness;
    if (snapshot.data === null || state === 'unavailable') {
      unavailableCount += 1;
      continue;
    }
    if (state === 'stale') anyStale = true;
    if (fetchedAt === null) continue;

    const ms = Date.parse(fetchedAt);
    if (!Number.isNaN(ms) && (oldest === null || ms < oldest.ms)) oldest = { iso: fetchedAt, ms };
  }

  return { oldestFetchedAt: oldest?.iso ?? null, anyStale, unavailableCount };
}

/**
 * The poll the board's ranks come from ("AP Top 25"), shown once in the header
 * so no card has to repeat it (§7: a rank is labeled, never inferred). `null`
 * when no team is ranked, because then there is nothing to attribute.
 */
export function rankingPollOf(board: Pick<BoardResponse, 'teams'>): string | null {
  for (const { snapshot } of board.teams) {
    const ranking = snapshot.data?.ranking;
    if (ranking?.kind === 'ranked') return ranking.poll;
  }
  return null;
}
