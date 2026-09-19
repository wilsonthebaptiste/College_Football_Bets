import type { Envelope, Season, SeasonSource } from '@cfb/shared';
import { resolveCurrentSeason } from '@cfb/shared';
import { cacheKey, policyFor } from '../cache/policy';
import type { Services } from '../services/context';

/**
 * The Worker's single entry point into season logic (§21). All three
 * precedence levels are wired:
 *
 *   1. `SEASON_OVERRIDE`           — an operator pinning the season
 *   2. the provider's calendar     — cached 6 h (plan §5), knows the week
 *   3. the date heuristic          — always answers, never knows the week
 *
 * The calendar read goes through the cache like any other provider data, so a
 * provider outage falls back to a stale calendar, then to the date, and never
 * leaves a request without a season.
 */

export interface SeasonResolution {
  season: Season;
  source: SeasonSource;
  /** The calendar read, when the provider was consulted. Drives `/api/meta/season`. */
  calendar: Envelope<Season | null> | null;
}

export interface ResolveOptions {
  /**
   * Use only what is already cached; never call the provider. For
   * `/api/health`, which is what you check when the provider is suspect.
   */
  peek?: boolean;
}

export async function resolveSeason(
  services: Services,
  options: ResolveOptions = {},
): Promise<SeasonResolution> {
  const { cache, provider } = services;
  const key = cacheKey('season_calendar', provider.name);
  let calendar: Envelope<Season | null> | null = null;

  const resolved = await resolveCurrentSeason({
    now: new Date(services.now()),
    override: services.env.SEASON_OVERRIDE ?? null,
    fetchProviderSeason: async () => {
      if (options.peek === true) {
        return (await cache.peek<Season | null>(key))?.value ?? null;
      }
      const read = await cache.read<Season | null>({
        key,
        policyFor: () => policyFor('season_calendar'),
        load: () => provider.getCurrentSeason(),
      });
      calendar = read.envelope;
      return read.envelope.data;
    },
  });

  return { ...resolved, calendar };
}
