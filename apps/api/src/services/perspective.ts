import type { Game, GameResult, TeamRecord } from '@cfb/shared';
import { OPPONENT_LOGO_PX, sizedLogoUrl } from '../providers/logos';
import type { ProviderCompetitor, ProviderGame } from '../providers/types';

/**
 * A provider's neutral game → the `Game` a card shows, from one team's side.
 *
 * Provider-agnostic on purpose: "which side are we, and did we win" is the
 * same question for every provider, so it is answered once, here.
 */

interface Sides {
  us: ProviderCompetitor;
  them: ProviderCompetitor;
  side: 'home' | 'away';
}

function sidesOf(game: ProviderGame, providerTeamId: string): Sides | null {
  if (game.home.team.providerTeamId === providerTeamId) {
    return { us: game.home, them: game.away, side: 'home' };
  }
  if (game.away.team.providerTeamId === providerTeamId) {
    return { us: game.away, them: game.home, side: 'away' };
  }
  return null;
}

export function isParticipant(game: ProviderGame, providerTeamId: string): boolean {
  return sidesOf(game, providerTeamId) !== null;
}

/** `null` when the team is not in this game. */
export function toTeamGame(game: ProviderGame, providerTeamId: string): Game | null {
  const sides = sidesOf(game, providerTeamId);
  if (sides === null) return null;
  const { us, them, side } = sides;

  // §5 invariant: `result !== null ⟺ status === 'final'`. Normalizers
  // guarantee a final game has a verdict. If one ever arrives without, the
  // honest move is a neutral status, not a guessed result.
  let status = game.status;
  let result: GameResult | null = null;
  if (status === 'final') {
    if (us.winner === true) result = 'W';
    else if (them.winner === true) result = 'L';
    else if (us.winner === false && them.winner === false) result = 'T';
    else status = 'unknown';
  }

  return {
    providerGameId: game.providerGameId,
    season: game.season,
    week: game.week,
    kickoffUtc: game.kickoffUtc,
    kickoffTbd: game.kickoffTbd,
    status,
    statusDetail: game.statusDetail,
    period: game.period,
    clock: game.clock,
    // §19: the provider's own designation. A neutral site overrides it.
    homeAway: game.neutralSite ? 'neutral' : side,
    // Drawn at 24 px in a schedule row; no need to ship the 500 px original.
    opponent: { ...them.team, logoUrl: sizedLogoUrl(them.team.logoUrl, OPPONENT_LOGO_PX) },
    teamScore: us.score,
    opponentScore: them.score,
    result,
    venue: game.venue,
    broadcast: game.broadcast,
  };
}

/** The team's record as the provider reported it on this game. */
export function recordOn(game: ProviderGame, providerTeamId: string): TeamRecord | null {
  return sidesOf(game, providerTeamId)?.us.record ?? null;
}
