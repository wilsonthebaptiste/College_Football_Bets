/**
 * The owner's scoring rubric, as code.
 *
 * Pure arithmetic over probabilities two publishers already compute. No network,
 * no clock, no provider knowledge. Every constant that governs a judgement is
 * named here, beside the thing it governs, so that tuning one is a one-line
 * change that has to be argued for against the tests.
 *
 * ## The rubric
 *
 * | Outcome                                | Points |
 * | -------------------------------------- | ------ |
 * | National champion                      |  5     |
 * | National championship runner-up        |  4     |
 * | Making the playoff                     |  3     |
 * | Conference champion, power four        |  3     |
 * | Conference runner-up, power four       |  2     |
 * | Top 25 finish                          |  1     |
 * | Unranked finish                        | −1     |
 *
 * Points compound, so the national champion of a power-four conference scores
 * 5 + 3 + 3 + 1 = 12, and a team that finishes unranked scores −1. Those are the
 * ceiling and the floor.
 *
 * ## Expected points
 *
 * With `a` = P(wins the title), `b` = P(plays in the title game), `c` = P(makes
 * the playoff), `d` = P(wins its conference), `e` = P(plays in the conference
 * championship game), and `p` = P(finishes in the final Top 25):
 *
 * ```
 * E = 5a
 *   + 4·max(0, b − a)      runner-up: in the game and does not win it
 *   + 3c
 *   + 3d                   power four only; a structural 0 for everyone else
 *   + 2·max(0, e − d)      power four only
 *   + (2p − 1)             the finish term
 * ```
 *
 * Three things in that are load-bearing:
 *
 * - **The runner-up terms are differences, not quotations.** `b` is the chance
 *   of REACHING the title game, so `b − a` is the chance of losing it. Both
 *   differences are floored at zero, because a publisher's rounding can put one
 *   slightly negative and a negative probability must never reach the
 *   arithmetic. When that happens it is recorded as an anomaly.
 * - **The finish term collapses to one number.** A team finishes in exactly one
 *   of two paid states, so `1·p + (−1)·(1 − p) = 2p − 1`. It runs from −1 to +1
 *   and is the only term that can be negative.
 * - **Nothing needs a "did it compound" rule.** The outcomes are nested in the
 *   publishers' own numbers (`a ≤ b ≤ c`), so a champion's 5, its playoff 3 and
 *   its finish +1 all land in the sum automatically.
 */

import type {
  BoardProjection,
  ConferenceStanding,
  OutcomeKind,
  ProjectionAnomaly,
  ProjectionInputs,
  ProjectionSource,
  ProjectionTerm,
  TeamProjection,
} from './domain/projection';
import type { RankingState } from './domain/ranking';
import type { Season } from './season';
import { seasonProgress } from './season';

/**
 * The points table, as data. The single source of truth for what an outcome is
 * worth; nothing else in the application may name one of these numbers.
 */
export const RUBRIC = {
  national_champion: 5,
  national_runner_up: 4,
  playoff: 3,
  conference_champion: 3,
  conference_runner_up: 2,
  /** A Top-25 finish. Its opposite is `UNRANKED_FINISH_POINTS`. */
  final_ranking: 1,
} as const satisfies Record<OutcomeKind, number>;

/** The rubric's one negative line: finishing outside the final Top 25. */
export const UNRANKED_FINISH_POINTS = -1;

/** The rubric's ceiling — a power-four national champion that finishes ranked. */
export const MAX_POINTS =
  RUBRIC.national_champion + RUBRIC.playoff + RUBRIC.conference_champion + RUBRIC.final_ranking;

/** The rubric's floor — a team that finishes unranked with nothing else. */
export const MIN_POINTS = UNRANKED_FINISH_POINTS;

/** Rubric order. Every `TeamProjection` carries its terms in this order. */
export const OUTCOME_ORDER: readonly OutcomeKind[] = [
  'national_champion',
  'national_runner_up',
  'playoff',
  'conference_champion',
  'conference_runner_up',
  'final_ranking',
];

// ─── P(finishes in the final Top 25) — the one thing we model ────────────────
// Early in the season the current poll is weak evidence; late in the season it
// is nearly conclusive. So the estimate blends a rank-based model with the
// current fact, weighted by how much season is behind us.

/** P(a team ranked #1 today finishes in the final Top 25). */
export const TOP25_AT_1 = 0.95;

/** P(a team ranked #25 today finishes in the final Top 25). */
export const TOP25_AT_25 = 0.55;

/**
 * How fast the estimate decays below the poll for an unranked team, in places of
 * FPI rank. Larger is flatter.
 */
export const FPI_DECAY = 18;

/** How many teams a poll ranks. The model's two anchors sit at its ends. */
export const POLL_SIZE = 25;

/**
 * The rank-based half of the Top-25 estimate, before the current fact is blended
 * in. Linear across the poll, exponential below it.
 *
 * `null` means there is no rank evidence at all, and the finish term is then
 * `unavailable` rather than guessed. Note that an `unavailable` poll produces
 * `null` even when FPI's rank is known: the blend needs to know whether the team
 * is ranked RIGHT NOW, and a failed poll read is precisely what does not say.
 */
export function top25Baseline(ranking: RankingState, fpiRank: number | null): number | null {
  if (ranking.kind === 'ranked') {
    const rank = Math.min(Math.max(Math.round(ranking.rank), 1), POLL_SIZE);
    return TOP25_AT_1 - ((rank - 1) * (TOP25_AT_1 - TOP25_AT_25)) / (POLL_SIZE - 1);
  }
  if (ranking.kind === 'unavailable') return null;

  // Unranked, so the only evidence left is FPI's own ordering of everybody.
  if (fpiRank === null || !Number.isFinite(fpiRank) || fpiRank < 1) return null;
  const decayed = TOP25_AT_25 * Math.exp(-(fpiRank - POLL_SIZE) / FPI_DECAY);
  // The cap matters: a team FPI ranks inside its top 25 but the poll does not
  // list must not come out ABOVE the #25 anchor.
  return Math.min(TOP25_AT_25, decayed);
}

export interface Top25Args {
  ranking: RankingState;
  fpiRank: number | null;
  /** `seasonProgress(season)`, or 1 to evaluate the rubric at its limit. */
  seasonWeight: number;
}

/**
 * `p = (1 − w)·baseline + w·(currently ranked ? 1 : 0)`.
 *
 * As `w` approaches 1 the estimate converges on the fact, which is the point:
 * once the final poll is published the projection stops being a projection and
 * becomes the score.
 */
export function top25Probability(args: Top25Args): number | null {
  const baseline = top25Baseline(args.ranking, args.fpiRank);
  if (baseline === null) return null;

  const weight = clamp01(args.seasonWeight);
  const currentFact = args.ranking.kind === 'ranked' ? 1 : 0;
  return clamp01((1 - weight) * baseline + weight * currentFact);
}

// ─── One team ────────────────────────────────────────────────────────────────

/**
 * The rubric at one explicit weight.
 *
 * Exported separately from `projectTeam` because the rubric's limit — `w = 1`,
 * every probability 0 or 1, the projection having become the score — is this
 * feature's sharpest test, and `seasonProgress` never returns 1.
 */
export function projectTeamAtWeight(
  inputs: ProjectionInputs,
  seasonWeight: number,
): TeamProjection {
  const anomalies: ProjectionAnomaly[] = [];
  const { fpi } = inputs;

  const fpiSource = fpi === null ? null : fpi.source;
  const a = fpi === null ? null : readProbability(fpi.winTitle, 'national_champion', anomalies);
  const b =
    fpi === null ? null : readProbability(fpi.makeTitleGame, 'national_runner_up', anomalies);
  const c = fpi === null ? null : readProbability(fpi.makePlayoffs, 'playoff', anomalies);

  const conference = readConference(inputs.conference, anomalies);

  const finish = top25Probability({
    ranking: inputs.ranking,
    fpiRank: fpi?.fpiRank ?? null,
    seasonWeight,
  });

  const terms: ProjectionTerm[] = [
    quoted('national_champion', a, fpiSource),
    quoted('national_runner_up', shortfall('national_runner_up', b, a, anomalies), fpiSource),
    quoted('playoff', c, fpiSource),
    conference.standing === 'not_eligible'
      ? structuralZero('conference_champion')
      : quoted('conference_champion', conference.win, conference.source),
    conference.standing === 'not_eligible'
      ? structuralZero('conference_runner_up')
      : quoted(
          'conference_runner_up',
          shortfall('conference_runner_up', conference.reach, conference.win, anomalies),
          conference.source,
        ),
    finishTerm(finish, inputs.estimateSource),
  ];

  // A board of entirely `not_eligible` zeros must not read as a confident 0.00,
  // so a total needs at least one quoted number behind it.
  const anyKnown = terms.some((term) => term.state === 'known');
  const total = anyKnown ? terms.reduce((sum, term) => sum + (term.contribution ?? 0), 0) : null;

  return {
    providerTeamId: inputs.providerTeamId,
    terms,
    total,
    complete: terms.every((term) => term.state !== 'unavailable'),
    anomalies,
  };
}

/** The rubric at the weight this season implies. */
export function projectTeam(inputs: ProjectionInputs, season: Season): TeamProjection {
  return projectTeamAtWeight(inputs, seasonProgress(season));
}

// ─── One board ───────────────────────────────────────────────────────────────

/**
 * Sums the teams' UNROUNDED totals and rounds nothing. Summing six rounded
 * numbers drifts, which is why `total` is a number and not a string all the way
 * out to the edge.
 */
export function projectBoard(teams: readonly TeamProjection[]): BoardProjection {
  const counted = teams.filter((team) => team.total !== null);
  return {
    teams: [...teams],
    total: counted.length === 0 ? null : counted.reduce((sum, team) => sum + (team.total ?? 0), 0),
    teamsCounted: counted.length,
    teamsTotal: teams.length,
  };
}

// ─── The display edge ────────────────────────────────────────────────────────

/** Two decimal places, as the owner asked. */
export const POINTS_DECIMALS = 2;

/**
 * Round once, at the edge. Also the only place `-0` is killed: `-0.004` must
 * display as `0.00`, never as `-0.00`.
 */
export function roundPoints(value: number): number {
  const factor = 10 ** POINTS_DECIMALS;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/**
 * The 2-dp string. Shipped alongside the unrounded number so that two clients
 * cannot round differently.
 *
 * The minus sign here is ASCII; swapping it for a typographic one is the web
 * app's business, not the contract's.
 */
export function formatPoints(value: number): string {
  return roundPoints(value).toFixed(POINTS_DECIMALS);
}

// ─── Internals ───────────────────────────────────────────────────────────────

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Narrows one publisher-supplied probability. Anything outside 0–1 is clamped
 * and recorded; anything not finite is discarded, because a `NaN` reaching the
 * arithmetic puts `NaN` on screen.
 */
function readProbability(
  raw: number,
  outcome: OutcomeKind,
  anomalies: ProjectionAnomaly[],
): number | null {
  if (!Number.isFinite(raw)) {
    anomalies.push({ kind: 'probability_not_finite', outcome, detail: String(raw) });
    return null;
  }
  if (raw < 0 || raw > 1) {
    const clamped = Math.min(Math.max(raw, 0), 1);
    anomalies.push({
      kind: 'probability_out_of_range',
      outcome,
      detail: `${String(raw)} clamped to ${String(clamped)}`,
    });
    return clamped;
  }
  return raw;
}

/**
 * `max(0, outer − inner)` — the chance of reaching a stage and losing it.
 * A publisher's rounding can invert the two; that is floored and recorded, never
 * allowed through as a negative probability.
 */
function shortfall(
  outcome: OutcomeKind,
  outer: number | null,
  inner: number | null,
  anomalies: ProjectionAnomaly[],
): number | null {
  if (outer === null || inner === null) return null;
  const difference = outer - inner;
  if (difference < 0) {
    anomalies.push({
      kind: 'negative_difference',
      outcome,
      detail: `${String(outer)} − ${String(inner)} = ${String(difference)}, floored to 0`,
    });
    return 0;
  }
  return difference;
}

interface ConferenceReading {
  standing: ConferenceStanding['kind'];
  win: number | null;
  reach: number | null;
  source: ProjectionSource | null;
}

function readConference(
  standing: ConferenceStanding,
  anomalies: ProjectionAnomaly[],
): ConferenceReading {
  if (standing.kind !== 'odds') {
    return { standing: standing.kind, win: null, reach: null, source: null };
  }
  return {
    standing: 'odds',
    win: readProbability(standing.winConference, 'conference_champion', anomalies),
    reach: readProbability(standing.reachConferenceGame, 'conference_runner_up', anomalies),
    source: standing.source,
  };
}

/** A term whose probability a publisher gave us, or could not. */
function quoted(
  kind: OutcomeKind,
  probability: number | null,
  source: ProjectionSource | null,
): ProjectionTerm {
  const points = RUBRIC[kind];
  if (probability === null || source === null) {
    return { kind, state: 'unavailable', points, probability: null, contribution: null, source };
  }
  return { kind, state: 'known', points, probability, contribution: points * probability, source };
}

/** A term the team cannot be paid for. A fact, worth 0, with no source. */
function structuralZero(kind: OutcomeKind): ProjectionTerm {
  return {
    kind,
    state: 'not_eligible',
    points: RUBRIC[kind],
    probability: null,
    contribution: 0,
    source: null,
  };
}

/**
 * The finish term, the one number we model. Its contribution is the whole
 * expectation over two paid states rather than `points × probability`, because a
 * team finishes in exactly one of them: `1·p + (−1)·(1 − p)`.
 */
function finishTerm(probability: number | null, source: ProjectionSource): ProjectionTerm {
  const points = RUBRIC.final_ranking;
  if (probability === null) {
    return {
      kind: 'final_ranking',
      state: 'unavailable',
      points,
      probability: null,
      contribution: null,
      source: null,
    };
  }
  return {
    kind: 'final_ranking',
    state: 'known',
    points,
    probability,
    contribution: points * probability + UNRANKED_FINISH_POINTS * (1 - probability),
    source,
  };
}
