import type { Env } from '../env';
import { oddsProviderName, providerName } from '../env';
import { EspnClient } from './espn/client';
import { EspnProvider } from './espn/provider';
import { FaultyConferenceOddsProvider, FaultyProvider, parseFaults } from './faults';
import { MockConferenceOddsProvider, MockProvider } from './mock/provider';
import { PlayoffStatusClient } from './playoffstatus/client';
import { POWER_FOUR } from './playoffstatus/conferences';
import { PlayoffStatusProvider } from './playoffstatus/provider';
import type { ConferenceOddsProvider, SportsDataProvider } from './types';

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

/**
 * The conference odds publisher, selected by `CONFERENCE_ODDS_PROVIDER` and
 * chosen independently of the sports provider.
 *
 * Independently on purpose: these are two publishers with two failure modes,
 * and the projection has to degrade in labelled pieces (§42). It also means
 * `SPORTS_PROVIDER=espn` alone never scrapes anybody's site — that takes its
 * own, deliberate, setting.
 *
 * The mock is given the power four so that it pays out on exactly the
 * conferences the rubric pays for, and every other team is a structural zero.
 *
 * The real client is deliberately NOT given `ESPN_USER_AGENT`: that variable
 * exists because ESPN's CDN judges it, and this is a different site. The
 * client's own default already identifies the project.
 */
export function createConferenceOddsProvider(env: Env): ConferenceOddsProvider {
  const base: ConferenceOddsProvider =
    oddsProviderName(env) === 'playoffstatus'
      ? new PlayoffStatusProvider(new PlayoffStatusClient())
      : new MockConferenceOddsProvider(POWER_FOUR);

  const faults = parseFaults(env.SPORTS_PROVIDER_FAULT);
  return faults === null ? base : new FaultyConferenceOddsProvider(base, faults);
}
