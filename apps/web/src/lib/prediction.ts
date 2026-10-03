import type { Game, Prediction, TeamSnapshot } from '@cfb/shared';

/**
 * §12 — the game a team page's prediction is about: the one being played now,
 * else the next one (after a bye, the game that follows it). `null` when there
 * is none, e.g. the season is over.
 *
 * A final game is never a target. Providers go on answering with the PREGAME
 * numbers after the final whistle (plan, Phase 2 findings), and a prediction
 * beside a result it already failed or passed is not information (§46).
 */
export function predictionTarget(snapshot: TeamSnapshot): Game | null {
  const slot = snapshot.nextGame;
  const game =
    snapshot.liveGame ??
    (slot.kind === 'game' ? slot.game : slot.kind === 'bye' ? slot.following : null);
  if (game === null || game.status === 'final' || game.status === 'canceled') return null;
  return game;
}

export interface PredictionSideView {
  name: string;
  /** The provider's figure, 0–100, unmodified. */
  pct: number;
  /** This side's share of the bar, 0–100. Only differs from `pct` if the two don't sum to 100. */
  share: number;
  /** The team whose page this is. Never true on a page that views neither team. */
  ours: boolean;
}

export interface PredictionView {
  /** In the order the page asked for (`PredictionOrder`). */
  sides: [PredictionSideView, PredictionSideView];
}

/** A team as a prediction names it: the provider's id, and what this page calls it. */
export interface NamedTeam {
  providerTeamId: string;
  name: string;
}

/**
 * Which side a prediction lists first, and which (if any) is "ours".
 *
 * - `viewed_team`: a team's page. That team first, as in §12's example
 *   ("Alabama — 67%, Tennessee — 33%"), and marked as the page's own.
 * - `away_home`: a page about the game itself (the matchup page), which views
 *   neither team. Away first, then home, as the page's heading reads
 *   ("Ohio State at Iowa"), and neither side is marked.
 *
 * One parameter rather than a second component, so the panel's wording —
 * the source line, the pregame caveat, every "unavailable" reason — cannot
 * drift between the two pages (plan-matchup-board, Phase 2).
 */
export type PredictionOrder =
  | { kind: 'viewed_team'; team: NamedTeam; opponent: NamedTeam }
  | { kind: 'away_home'; away: NamedTeam; home: NamedTeam };

/** The order a team page uses: its own team first, against the game's opponent. */
export function viewedTeamOrder(team: NamedTeam, game: Pick<Game, 'opponent'>): PredictionOrder {
  return {
    kind: 'viewed_team',
    team,
    opponent: { providerTeamId: game.opponent.providerTeamId, name: game.opponent.name },
  };
}

const isPct = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 100;

/**
 * A prediction laid out in the page's order, or `null` when it cannot be shown
 * honestly: it is about a different game, or its numbers are not percentages.
 * A bad figure is reported as unavailable, never repaired (§12: no percentage
 * the provider did not supply).
 *
 * Sides are matched by provider team id, never by position (§19). A side the
 * page does not know is shown under the provider's own name. With
 * `viewed_team`, if neither side is the viewed team, both are shown away first
 * and neither is marked as ours. With `away_home`, the side matching the
 * page's away team comes first; if neither matches, the provider's away side.
 */
export function predictionView(
  prediction: Prediction,
  providerGameId: string,
  order: PredictionOrder,
): PredictionView | null {
  if (prediction.providerGameId !== providerGameId) return null;
  const { home, away, homeWinPct, awayWinPct } = prediction;
  if (!isPct(homeWinPct) || !isPct(awayWinPct)) return null;

  const known =
    order.kind === 'viewed_team' ? [order.team, order.opponent] : [order.away, order.home];
  const total = homeWinPct + awayWinPct;
  const shareOf = (pct: number): number => (total > 0 ? (pct / total) * 100 : 50);
  const nameOf = (side: Prediction['home']): string =>
    known.find((team) => team.providerTeamId === side.providerTeamId)?.name ?? side.name;
  const isOurs = (side: Prediction['home']): boolean =>
    order.kind === 'viewed_team' && side.providerTeamId === order.team.providerTeamId;

  const view = (side: Prediction['home'], pct: number): PredictionSideView => ({
    name: nameOf(side),
    pct,
    share: shareOf(pct),
    ours: isOurs(side),
  });
  const homeSide = view(home, homeWinPct);
  const awaySide = view(away, awayWinPct);
  const homeFirst =
    order.kind === 'viewed_team'
      ? homeSide.ours
      : home.providerTeamId === order.away.providerTeamId;
  return { sides: homeFirst ? [homeSide, awaySide] : [awaySide, homeSide] };
}
