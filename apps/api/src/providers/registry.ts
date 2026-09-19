import type { Env } from '../env';
import { providerName } from '../env';
import { EspnClient } from './espn/client';
import { EspnProvider } from './espn/provider';
import { FaultyProvider, parseFaults } from './faults';
import { MockProvider } from './mock/provider';
import type { SportsDataProvider } from './types';

/**
 * Provider selection by `SPORTS_PROVIDER`. Adding a provider is one directory
 * beside `espn/` and one branch here; that is the acceptance test for §5.
 */
export function createProvider(env: Env, now: () => number = Date.now): SportsDataProvider {
  const base: SportsDataProvider =
    providerName(env) === 'espn'
      ? new EspnProvider(new EspnClient({ userAgent: env.ESPN_USER_AGENT }), now)
      : new MockProvider(now);

  const faults = parseFaults(env.SPORTS_PROVIDER_FAULT);
  return faults === null ? base : new FaultyProvider(base, faults);
}
