import type { Envelope, Game, Prediction } from '@cfb/shared';
import type { CachePolicy } from '../cache/policy';
import { cacheKey, policyFor } from '../cache/policy';
import type { CacheStatus } from '../cache/swr';
import { invalidRequest } from '../http/errors';
import type { ProviderGame } from '../providers/types';
import { ProviderError } from '../providers/types';
import type { Services } from './context';
import { isParticipant, toTeamGame } from './perspective';

/**
 * `GET /api/games/:gameId` and `…/prediction`.
 *
 * A game's TTL depends on what it is (§23): a final game is cached for a week,
 * a live one for 25 seconds, anything else for 10 minutes. So the category is
 * chosen after the game is fetched, from the game itself.
 */

/** "No such game" must reach the client as a 404, not as a stale copy of nothing. */
const isNotFound = (error: unknown): boolean =>
  error instanceof ProviderError && error.kind === 'not_found';

function policyForGame(game: ProviderGame): CachePolicy {
  if (game.status === 'final') return policyFor('completed_game');
  if (game.status === 'live' || game.status === 'delayed' || game.status === 'suspended') {
    return policyFor('live_game');
  }
  return policyFor('upcoming_game');
}

export interface GameResult<T> {
  envelope: Envelope<T>;
  cacheStatus: CacheStatus;
}

/**
 * The game from one participant's side. `perspective` is a provider team id;
 * without one, the home team's side is used, which is a stated default rather
 * than a guess (§19: home is the provider's own designation).
 */
export async function getGame(
  services: Services,
  providerGameId: string,
  perspective: string | null,
): Promise<GameResult<Game>> {
  const { cache, provider } = services;
  const read = await cache.read<ProviderGame>({
    key: cacheKey('game', provider.name, providerGameId),
    policyFor: policyForGame,
    load: () => provider.getGame(providerGameId),
    isFatal: isNotFound,
  });

  const game = read.envelope.data;
  if (game === null) {
    const { freshness, error } = read.envelope;
    return { envelope: { data: null, freshness, error }, cacheStatus: read.status };
  }

  const side = perspective ?? game.home.team.providerTeamId;
  if (!isParticipant(game, side)) {
    throw invalidRequest('That team is not playing in this game.');
  }
  return {
    envelope: { ...read.envelope, data: toTeamGame(game, side) },
    cacheStatus: read.status,
  };
}

/**
 * §12 — `data: null` with `error: null` is "Prediction unavailable": the
 * provider was asked and has none. Distinct from a failed request, which
 * carries an error. Neither ever becomes a number.
 */
export async function getPrediction(
  services: Services,
  providerGameId: string,
): Promise<GameResult<Prediction | null>> {
  const { cache, provider } = services;
  const read = await cache.read<Prediction | null>({
    key: cacheKey('prediction', provider.name, providerGameId),
    policyFor: () => policyFor('prediction'),
    load: () => provider.getPrediction(providerGameId),
    isFatal: isNotFound,
  });
  return { envelope: read.envelope, cacheStatus: read.status };
}
