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
  /** The team whose page this is. */
  ours: boolean;
}

export interface PredictionView {
  /** Viewed team first, as in §12's example ("Alabama — 67%, Tennessee — 33%"). */
  sides: [PredictionSideView, PredictionSideView];
}

const isPct = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 100;

/**
 * A prediction laid out from the viewed team's side, or `null` when it cannot
 * be shown honestly: it is about a different game, or its numbers are not
 * percentages. A bad figure is reported as unavailable, never repaired (§12:
 * no percentage the provider did not supply).
 *
 * Sides are matched by provider team id, never by position (§19). If neither
 * side is the viewed team, both are shown as the provider named them, away
 * team first, and neither is marked as ours.
 */
export function predictionView(
  prediction: Prediction,
  game: Game,
  team: { providerTeamId: string; name: string },
): PredictionView | null {
  if (prediction.providerGameId !== game.providerGameId) return null;
  const { home, away, homeWinPct, awayWinPct } = prediction;
  if (!isPct(homeWinPct) || !isPct(awayWinPct)) return null;

  const total = homeWinPct + awayWinPct;
  const shareOf = (pct: number): number => (total > 0 ? (pct / total) * 100 : 50);
  const nameOf = (side: Prediction['home']): string =>
    side.providerTeamId === team.providerTeamId
      ? team.name
      : side.providerTeamId === game.opponent.providerTeamId
        ? game.opponent.name
        : side.name;

  const view = (side: Prediction['home'], pct: number): PredictionSideView => ({
    name: nameOf(side),
    pct,
    share: shareOf(pct),
    ours: side.providerTeamId === team.providerTeamId,
  });
  const homeSide = view(home, homeWinPct);
  const awaySide = view(away, awayWinPct);
  return { sides: homeSide.ours ? [homeSide, awaySide] : [awaySide, homeSide] };
}
