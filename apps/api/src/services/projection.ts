import type { ConferenceStanding, TeamIdentity } from '@cfb/shared';
import { cacheKey, policyFor } from '../cache/policy';
import type { CacheRead } from '../cache/swr';
import { isPowerFour } from '../providers/playoffstatus/conferences';
import type {
  ConferenceMap,
  ConferenceOddsDocument,
  TeamProjectionInputs,
  TeamProjectionsDocument,
} from '../providers/types';
import { resolveSeason } from '../season/resolve';
import type { Services } from './context';
import { teamNameKey } from './teamNames';

/**
 * The two documents projected points is computed from, and the join between
 * them (context/predicting_score.md, Phase 2).
 *
 * Nothing here applies the rubric — that is `packages/shared/src/scoring.ts`,
 * and it is pure. This module is the part that has to talk to two publishers,
 * two caches, and a team list, and it stops at producing the inputs.
 *
 * ## Why two reads and not one
 *
 * The documents have independent failure modes and the response must degrade
 * in labelled pieces: FPI down leaves the conference terms standing, the
 * scrape down leaves the national terms standing, and the screen says which
 * publisher each number came from (§42, §46). Fusing them into one cache entry
 * would make either failure take out both halves.
 */

/**
 * ESPN's FPI table, through the cache (6 h).
 *
 * Not season-scoped in the key, because the endpoint is not season-scoped: it
 * answers for whatever season ESPN is currently rating and stamps it with
 * `lastUpdated`. A season part in the key would promise a per-season document
 * that does not exist.
 */
export async function readProjectionInputs(
  services: Services,
): Promise<CacheRead<TeamProjectionsDocument>> {
  const { cache, provider } = services;
  return cache.read<TeamProjectionsDocument>({
    key: cacheKey('projection_inputs', provider.name),
    policyFor: () => policyFor('projection_inputs'),
    load: () => provider.getTeamProjections(),
  });
}

/**
 * The conference odds document, through its OWN cache (6 h).
 *
 * `services.oddsCache` rather than `services.cache`: freshness has to be
 * labelled with the publisher that produced it, and the sports provider did
 * not produce this. A conference term stamped `espn` would be the §46 mistake
 * at the envelope level.
 */
export async function readConferenceOdds(
  services: Services,
): Promise<CacheRead<ConferenceOddsDocument>> {
  const { oddsCache, oddsProvider } = services;
  const { season } = await resolveSeason(services);
  return oddsCache.read<ConferenceOddsDocument>({
    key: cacheKey('conference_odds', oddsProvider.name, String(season.year)),
    policyFor: () => policyFor('conference_odds'),
    load: () => oddsProvider.getConferenceOdds(season),
  });
}

// ─── The join ────────────────────────────────────────────────────────────────

export interface ConferenceOddsJoin {
  /** Provider team id → that team's odds. */
  byTeamId: Map<string, { winConference: number; reachConferenceGame: number }>;
  /**
   * Published rows that matched no team in the provider's list. Non-zero means
   * either a rename upstream or a missing alias, and either way some team's
   * conference term has silently gone `unavailable`.
   */
  unmatchedRows: string[];
  /**
   * Power-four teams in the conference map that no row covered. Non-zero means
   * a page lost a row — the failure mode a single regex over the table caused,
   * and the one the column sums alone would not always catch.
   */
  unmatchedTeams: string[];
}

/**
 * Published rows → provider team ids, reported in BOTH directions.
 *
 * Both directions matter and they fail differently. An unmatched row is a
 * name we could not resolve; an unmatched team is a row that was never there.
 * A caller that only checked one of them would miss half the ways this breaks.
 */
export function joinConferenceOdds(
  document: ConferenceOddsDocument,
  teams: readonly TeamIdentity[],
  conferences: ConferenceMap,
): ConferenceOddsJoin {
  const idByName = new Map<string, string>();
  for (const team of teams) {
    const key = teamNameKey(team.displayName ?? team.name);
    // First writer wins: the list is in the provider's order, and a later
    // duplicate of a name is not a better answer than the first.
    if (!idByName.has(key)) idByName.set(key, team.providerTeamId);
  }

  const byTeamId = new Map<string, { winConference: number; reachConferenceGame: number }>();
  const unmatchedRows: string[] = [];
  for (const row of document.rows) {
    const providerTeamId = idByName.get(teamNameKey(row.teamName));
    if (providerTeamId === undefined) {
      unmatchedRows.push(row.teamName);
      continue;
    }
    byTeamId.set(providerTeamId, {
      winConference: row.winConference,
      reachConferenceGame: row.reachConferenceGame,
    });
  }

  const unmatchedTeams: string[] = [];
  for (const [providerTeamId, conference] of Object.entries(conferences)) {
    if (!isPowerFour(conference)) continue;
    if (!byTeamId.has(providerTeamId)) unmatchedTeams.push(providerTeamId);
  }

  return { byTeamId, unmatchedRows, unmatchedTeams: unmatchedTeams.sort() };
}

// ─── Assembling one team's inputs ────────────────────────────────────────────

export interface ConferenceStandingArgs {
  providerTeamId: string;
  /** The team's conference short name, or `null` when the map could not be read. */
  conference: string | null;
  join: ConferenceOddsJoin | null;
  /** FPI's own figure, the labelled fallback when the scrape is gone. */
  fpiWinConference: number | null;
}

/**
 * One team's conference standing, in the three states §7's discipline requires.
 *
 * The order of these branches is the whole decision:
 *
 *   1. Not in the power four → `not_eligible`. A structural zero and a fact.
 *      Notre Dame genuinely cannot win a power-four conference, and that is
 *      different from a number we failed to load.
 *   2. The scrape resolved this team → `odds`, labelled `playoffstatus`.
 *   3. The scrape is gone but FPI published `probwinconf` → `odds`, labelled
 *      `espn_fpi`, with the CHAMPION figure only. FPI publishes no runner-up
 *      probability, so `reachConferenceGame` is set equal to it, which makes
 *      the runner-up term `max(0, e − d)` come out at exactly zero rather than
 *      inventing one. The two sources disagree by up to about 0.75 projected
 *      points per team, so this is a labelled substitute, never an average.
 *   4. Nothing → `unavailable`. Never a zero.
 *
 * A `null` conference — the map itself failed — is `unavailable` rather than
 * `not_eligible`: not knowing a team's conference is not the same as knowing
 * it is not in the power four.
 */
export function conferenceStandingFor(args: ConferenceStandingArgs): ConferenceStanding {
  if (args.conference !== null && !isPowerFour(args.conference)) return { kind: 'not_eligible' };

  const odds = args.join?.byTeamId.get(args.providerTeamId);
  if (odds !== undefined) {
    return {
      kind: 'odds',
      winConference: odds.winConference,
      reachConferenceGame: odds.reachConferenceGame,
      source: 'playoffstatus',
    };
  }

  if (args.fpiWinConference !== null) {
    return {
      kind: 'odds',
      winConference: args.fpiWinConference,
      reachConferenceGame: args.fpiWinConference,
      source: 'espn_fpi',
    };
  }

  return { kind: 'unavailable' };
}

/** FPI's figures for one team, or `null` when the publisher does not cover it. */
export function fpiInputsFor(
  document: TeamProjectionsDocument | null,
  providerTeamId: string,
): TeamProjectionInputs | null {
  return document?.teams.find((team) => team.providerTeamId === providerTeamId) ?? null;
}
