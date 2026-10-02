import type {
  ConferenceOddsDocument,
  ConferenceOddsPage,
  ConferenceOddsRow,
  TeamProjectionInputs,
  TeamProjectionsDocument,
} from '../types';
import { hash } from './generate';
import { ROSTER, type RosterTeam } from './roster';

/**
 * Synthetic projection inputs: the mock half of projected points.
 *
 * Two rules it exists to satisfy, beyond "no network":
 *
 *   - **Nothing wears a publisher's name.** Every figure is labelled
 *     `mock_projection`, so a mock projection cannot be mistaken for ESPN's or
 *     playoffstatus's (§46). That is the whole reason `ProjectionInputs` has
 *     three source fields rather than one.
 *   - **Every state the UI must handle is always on screen somewhere**, the
 *     same principle the generated season follows: a team with no FPI row at
 *     all, teams in and out of the power four, figures near zero and near one.
 *
 * Deterministic, from the team id alone. The real sources recompute daily, so
 * there is nothing to re-anchor to the clock.
 */

/**
 * Roughly one team in twenty-five has no FPI row at all, so the `unavailable`
 * projection — the one a non-FBS team on a board produces against ESPN — is
 * always visible in mock mode without anyone arranging it.
 */
const NO_FPI_EVERY = 25;

function unit(seed: string): number {
  return hash(seed) / 0x1_0000_0000;
}

export function mockHasProjection(team: RosterTeam): boolean {
  return hash(`fpi:${team.id}`) % NO_FPI_EVERY !== 0;
}

/**
 * The three national probabilities, nested the way a real publisher's are
 * (`winTitle ≤ makeTitleGame ≤ makePlayoffs`). The nesting matters: the
 * runner-up terms are DIFFERENCES, and inputs that invert them would exercise
 * the `negative_difference` anomaly path on every board rather than the normal
 * one.
 */
function nationalOdds(team: RosterTeam): {
  winTitle: number;
  makeTitleGame: number;
  makePlayoffs: number;
} {
  const strength = unit(`strength:${team.id}`);
  // Cubed, so a handful of teams are plausible contenders and most are not.
  const makePlayoffs = round4(strength ** 3);
  const makeTitleGame = round4(makePlayoffs * (0.2 + 0.5 * unit(`title:${team.id}`)));
  const winTitle = round4(makeTitleGame * (0.2 + 0.6 * unit(`champ:${team.id}`)));
  return { winTitle, makeTitleGame, makePlayoffs };
}

/** Four places, so a mock figure never arrives with float noise behind it. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function mockTeamProjections(): TeamProjectionsDocument {
  const teams: TeamProjectionInputs[] = [];
  for (const team of ROSTER) {
    if (!mockHasProjection(team)) continue;
    const odds = nationalOdds(team);
    teams.push({
      providerTeamId: team.id,
      fpi: {
        ...odds,
        // FPI's ordering of everybody, so an unranked team still has finish
        // evidence. Spread across the roster rather than tied to `strength`,
        // which would make rank and playoff odds perfectly correlated.
        fpiRank: 1 + (hash(`fpirank:${team.id}`) % 130),
        source: 'mock_projection',
      },
      winConference: round4(0.05 + 0.5 * unit(`conf:${team.id}`)),
    });
  }
  return {
    teams,
    computedLabel: MOCK_PROJECTION_LABEL,
    // The mock is not a sample of the league, so its sums will not land on
    // FPI's identities. Reported honestly rather than faked: the integrity
    // check belongs to the real payload, and the warning it produces here is
    // one nobody acts on because nothing in mock mode is a measurement.
    fieldSums: {
      winTitle: percentSum(teams, (team) => team.fpi.winTitle),
      makeTitleGame: percentSum(teams, (team) => team.fpi.makeTitleGame),
      makePlayoffs: percentSum(teams, (team) => team.fpi.makePlayoffs),
      winConference: percentSum(teams, (team) => team.winConference ?? 0),
    },
  };
}

function percentSum(
  teams: readonly TeamProjectionInputs[],
  read: (team: TeamProjectionInputs) => number,
): number {
  return teams.reduce((total, team) => total + read(team) * 100, 0);
}

/** Said in the mock's own voice, never in a publisher's (§46). */
export const MOCK_PROJECTION_LABEL = 'Mock projection (synthetic data)';

// ─── Conference odds ─────────────────────────────────────────────────────────

/**
 * Conference odds for the mock roster, keyed by the roster's own short names —
 * the same shape the real scrape produces, where rows carry the publisher's
 * spelling and the join to provider ids happens above the provider.
 *
 * Each conference's columns are normalized to one champion and two finalists,
 * so mock mode exercises the same integrity arithmetic the real pages do
 * rather than quietly skipping it.
 */
export function mockConferenceOdds(conferences: readonly string[]): ConferenceOddsDocument {
  const rows: ConferenceOddsRow[] = [];
  const pages: ConferenceOddsPage[] = [];

  for (const conference of conferences) {
    const members = ROSTER.filter((team) => team.conference === conference);
    if (members.length === 0) {
      pages.push({
        conference,
        computedLabel: MOCK_PROJECTION_LABEL,
        rows: 0,
        championPercent: 0,
        participatePercent: 0,
      });
      continue;
    }

    const weights = members.map((team) => 0.05 + unit(`mockconf:${conference}:${team.id}`));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const conferenceRows = members.map((team, index) => {
      const share = (weights[index] ?? 0) / total;
      return {
        teamName: team.short,
        conference,
        winConference: round4(share),
        // Two finalists, and a team that wins its conference played in the
        // game, so reaching it is always at least as likely as winning it.
        reachConferenceGame: round4(Math.min(1, share * 2)),
      };
    });

    rows.push(...conferenceRows);
    pages.push({
      conference,
      computedLabel: MOCK_PROJECTION_LABEL,
      rows: conferenceRows.length,
      championPercent: conferenceRows.reduce((sum, row) => sum + row.winConference * 100, 0),
      participatePercent: conferenceRows.reduce(
        (sum, row) => sum + row.reachConferenceGame * 100,
        0,
      ),
    });
  }

  return { rows, pages, computedLabel: MOCK_PROJECTION_LABEL };
}
