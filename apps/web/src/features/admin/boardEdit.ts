import { BOARD_TEAM_COUNT, type TeamIdentity, type UserTeamSelection } from '@cfb/shared';

/**
 * The board editor's decisions, kept as plain functions so they can be tested
 * without a browser (plan §5.1).
 */

/**
 * The list with one item moved one place up (`-1`) or down (`+1`), or `null`
 * when it is already at that end. Up/down buttons rather than drag and drop:
 * keyboard-accessible by construction, and the order is what matters.
 */
export function moveItem<T>(items: readonly T[], index: number, delta: -1 | 1): T[] | null {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return null;
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
}

export type SizeNote = { tone: 'info' | 'warn'; text: string } | null;

/**
 * Guardrail: a board is six teams (§13). More is allowed, and warned about;
 * fewer is simply said. Six says nothing.
 */
export function boardSizeNote(count: number): SizeNote {
  const six = String(BOARD_TEAM_COUNT);
  if (count > BOARD_TEAM_COUNT) {
    return {
      tone: 'warn',
      text: `This board has ${String(count)} teams. Boards are designed for ${six}, so the extra teams make it longer than the others.`,
    };
  }
  if (count === BOARD_TEAM_COUNT) return null;
  if (count === 0) return { tone: 'info', text: `This board has no teams yet. Add ${six}.` };
  const left = BOARD_TEAM_COUNT - count;
  return {
    tone: 'info',
    text: `This board has ${String(count)} of its ${six} teams. Add ${String(left)} more.`,
  };
}

/** The short name a card shows ("Alabama"), falling back to the full one. */
export function shortName(team: Pick<TeamIdentity, 'displayName' | 'name'>): string {
  return team.displayName ?? team.name;
}

/** Provider ids already on the board, so search results can say "On this board" (§3). */
export function onBoard(selections: readonly UserTeamSelection[]): Set<string> {
  return new Set(selections.map((selection) => selection.team.providerTeamId));
}

/** "Alabama moved to position 2 of 6." — what the live region says after a move. */
export function movedMessage(name: string, position: number, total: number): string {
  return `${name} moved to position ${String(position)} of ${String(total)}.`;
}
