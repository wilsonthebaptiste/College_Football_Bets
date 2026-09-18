import { resolveCurrentSeason, type ResolvedSeason } from '@cfb/shared';
import type { Env } from '../env';

/**
 * The Worker's single entry point into season logic (§21).
 *
 * Phase 1 wires two of the three precedence levels: `SEASON_OVERRIDE`, then the
 * date heuristic. Phase 2 adds the provider calendar in the middle by passing
 * `fetchProviderSeason` — which is the whole reason the parameter exists now.
 */
export async function resolveSeasonForRequest(env: Env): Promise<ResolvedSeason> {
  return resolveCurrentSeason({
    now: new Date(),
    override: env.SEASON_OVERRIDE ?? null,
    fetchProviderSeason: null,
  });
}
