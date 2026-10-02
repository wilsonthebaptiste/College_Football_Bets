import type { RankingState } from './ranking';

/**
 * Projected points — the owner's scoring rubric, applied forward.
 *
 * This is the first *computed* sports number in the application, and §4/§46 say
 * never to invent sports information. It is legitimate on three conditions, and
 * they are encoded here rather than left to a convention:
 *
 *   1. Every probability is QUOTED from a publisher. `ProjectionSource` is a
 *      closed union, exactly like `PredictionSource`, so nothing computed can
 *      wear a publisher's name by accident.
 *   2. The arithmetic is the owner's own rubric, applied to those quotations.
 *      It lives in `../scoring.ts` and nowhere else.
 *   3. Exactly ONE quantity is modelled by us — the chance a team finishes in
 *      the final Top 25 — and it is labelled `espn_poll_estimate`, named as our
 *      estimate in the response and on screen.
 *
 * A projection is never called "live". Its inputs move about once a day, so the
 * vocabulary is "Projection · as of <the publisher's own stamp>" (§23, §39).
 */

/**
 * Where each number in a projection came from.
 *
 * `espn_poll_estimate` is the only member that names something we computed, and
 * it says so. `mock_projection` exists so the offline provider can label its
 * synthetic numbers as exactly that — mock output must not wear ESPN's name or
 * playoffstatus's either (§46).
 */
export type ProjectionSource =
  'espn_fpi' | 'playoffstatus' | 'espn_poll_estimate' | 'mock_projection';

/** One line of the rubric. The six outcomes a team can be paid for. */
export type OutcomeKind =
  | 'national_champion'
  | 'national_runner_up'
  | 'playoff'
  | 'conference_champion'
  | 'conference_runner_up'
  | 'final_ranking';

/**
 * §7's three-state discipline, applied to a rubric line: a value, a structural
 * zero, or "we do not know". Never two of the three collapsed together.
 *
 * - `known`        — a publisher gave us the probability.
 * - `not_eligible` — the outcome is impossible for this team, and that is a
 *                    fact. Notre Dame cannot win a power-four conference.
 * - `unavailable`  — the outcome is possible and we could not load the number.
 *
 * `not_eligible` renders as `0.00` with a reason; `unavailable` renders as `—`.
 * Collapsing them would assert "zero chance" on the strength of a failed
 * request, which is the `unranked` / `unavailable` mistake in a new costume.
 */
export type ProjectionTermState = 'known' | 'not_eligible' | 'unavailable';

export interface ProjectionTerm {
  kind: OutcomeKind;
  state: ProjectionTermState;
  /** The rubric's points if the outcome happens. Constant per kind. */
  points: number;
  /** 0–1, the publisher's own number. `null` unless `state === 'known'`. */
  probability: number | null;
  /**
   * `points × probability`, unrounded. 0 when not eligible, `null` when unknown.
   *
   * The one exception is `final_ranking`, where a team finishes in exactly one
   * of two paid states, so the contribution is the full expectation
   * `TOP25 × p + UNRANKED × (1 − p)`, which collapses to `2p − 1`. It is the
   * only term that can be negative, and the UI shows it as a negative number
   * rather than hiding it.
   */
  contribution: number | null;
  source: ProjectionSource | null;
}

/**
 * ESPN FPI's published figures for one team, as probabilities in 0–1.
 *
 * FPI publishes percentages with float noise (`27.800000000000004`); dividing
 * by 100 is normalization's job, never the UI's, so by the time a value reaches
 * here it is already a probability.
 */
export interface FpiProjectionInputs {
  /** `probwintitle` — P(wins the national championship). */
  winTitle: number;
  /** `probmaketitlegame` — P(plays in the national championship game). */
  makeTitleGame: number;
  /** `probmakeplayoffs` — P(makes the playoff). */
  makePlayoffs: number;
  /**
   * `fpirank`, 1-based. It carries the Top-25 estimate for a team the poll does
   * not list; without it an unranked team has no finish evidence at all.
   * `null` when the payload omitted it.
   */
  fpiRank: number | null;
  source: ProjectionSource;
}

/**
 * The conference half of the rubric, three-state because the two zeros are
 * different facts (see `ProjectionTermState`).
 *
 * Only the power four pay conference points, so a Mountain West team is
 * `not_eligible` — not `unavailable`, and not a loaded zero.
 */
export type ConferenceStanding =
  | {
      kind: 'odds';
      /** P(wins its conference). */
      winConference: number;
      /** P(plays in the conference championship game). */
      reachConferenceGame: number;
      source: ProjectionSource;
    }
  | { kind: 'not_eligible' }
  | { kind: 'unavailable' };

/**
 * Everything one team's projection is computed from.
 *
 * Note the asymmetry, which is deliberate and the same one `TeamSnapshot` draws
 * between `record` and `ranking`: a missing FPI row has exactly one meaning —
 * the publisher has no figures for this team, which is true of every team
 * outside the 138 it covers — so `fpi` is nullable. A missing conference figure
 * has two meanings, so `conference` is a three-state union.
 */
export interface ProjectionInputs {
  providerTeamId: string;
  fpi: FpiProjectionInputs | null;
  conference: ConferenceStanding;
  /** The poll the app already displays, with its own three states (§7). */
  ranking: RankingState;
  /**
   * The label our Top-25 estimate wears, which depends on whose poll and whose
   * rank it read: `espn_poll_estimate` normally, `mock_projection` offline.
   */
  estimateSource: ProjectionSource;
}

export type ProjectionAnomalyKind =
  /** A publisher's rounding put a nested difference below zero (`b < a`). */
  | 'negative_difference'
  /** A probability arrived outside 0–1 and was clamped. */
  | 'probability_out_of_range'
  /** A probability arrived as `NaN` or `Infinity` and was discarded. */
  | 'probability_not_finite';

/**
 * Something the arithmetic survived but nobody should ignore.
 *
 * These are returned rather than logged from here: `packages/shared` is pure and
 * runs in the browser as well as the Worker, so the route that assembles a
 * projection does the logging. A caller that drops them loses a warning, not
 * correctness — every anomaly is already handled defensively at the point it is
 * recorded.
 */
export interface ProjectionAnomaly {
  kind: ProjectionAnomalyKind;
  outcome: OutcomeKind;
  /** Safe to log. Numbers only; never a provider URL. */
  detail: string;
}

export interface TeamProjection {
  providerTeamId: string;
  /** One entry per `OutcomeKind`, in rubric order. */
  terms: ProjectionTerm[];
  /**
   * The sum of the terms we have, UNROUNDED. Rounding is a display concern and
   * happens once, at the edge.
   *
   * `null` when no term is `known` — a team with two `not_eligible` conference
   * terms and nothing else would otherwise total a confident `0.00`, which is
   * the lie this whole feature is built to avoid.
   */
  total: number | null;
  /** True when no term is `unavailable`, i.e. `total` is the whole rubric. */
  complete: boolean;
  anomalies: ProjectionAnomaly[];
}

export interface BoardProjection {
  teams: TeamProjection[];
  /** The sum of the teams' UNROUNDED totals. `null` when none has one. */
  total: number | null;
  /**
   * How many of the board's teams contributed. A screen says "5 of 6 teams"
   * rather than quietly treating the sixth as zero.
   */
  teamsCounted: number;
  teamsTotal: number;
}
