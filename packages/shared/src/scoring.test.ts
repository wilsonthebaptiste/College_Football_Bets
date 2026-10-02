import { describe, expect, it } from 'vitest';
import type {
  ConferenceStanding,
  OutcomeKind,
  ProjectionInputs,
  TeamProjection,
} from './domain/projection';
import type { RankingState } from './domain/ranking';
import {
  FPI_DECAY,
  formatPoints,
  MAX_POINTS,
  MIN_POINTS,
  OUTCOME_ORDER,
  POLL_SIZE,
  projectBoard,
  projectTeam,
  projectTeamAtWeight,
  roundPoints,
  RUBRIC,
  top25Baseline,
  top25Probability,
  TOP25_AT_1,
  TOP25_AT_25,
} from './scoring';
import { seasonProgress, type Season } from './season';

// ─── Fixtures and helpers ────────────────────────────────────────────────────

const ranked = (rank: number): RankingState => ({
  kind: 'ranked',
  rank,
  poll: 'AP Top 25',
  week: 5,
});
const UNRANKED: RankingState = { kind: 'unranked' };
const NO_POLL: RankingState = { kind: 'unavailable' };

const POWER_FOUR = (winConference: number, reachConferenceGame: number): ConferenceStanding => ({
  kind: 'odds',
  winConference,
  reachConferenceGame,
  source: 'playoffstatus',
});
const NOT_POWER_FOUR: ConferenceStanding = { kind: 'not_eligible' };
const ODDS_MISSING: ConferenceStanding = { kind: 'unavailable' };

interface InputArgs {
  providerTeamId?: string;
  winTitle?: number;
  makeTitleGame?: number;
  makePlayoffs?: number;
  fpiRank?: number | null;
  /** `null` drops the FPI row entirely, as it is for every non-FBS team. */
  fpi?: null;
  conference?: ConferenceStanding;
  ranking?: RankingState;
}

function inputsFor(args: InputArgs): ProjectionInputs {
  return {
    providerTeamId: args.providerTeamId ?? 'team',
    fpi:
      args.fpi === null
        ? null
        : {
            winTitle: args.winTitle ?? 0,
            makeTitleGame: args.makeTitleGame ?? 0,
            makePlayoffs: args.makePlayoffs ?? 0,
            fpiRank: args.fpiRank === undefined ? null : args.fpiRank,
            source: 'espn_fpi',
          },
    conference: args.conference ?? NOT_POWER_FOUR,
    ranking: args.ranking ?? UNRANKED,
    estimateSource: 'espn_poll_estimate',
  };
}

function termOf(projection: TeamProjection, kind: OutcomeKind) {
  const term = projection.terms.find((candidate) => candidate.kind === kind);
  if (term === undefined) throw new Error(`no ${kind} term`);
  return term;
}

/**
 * "Matches to two decimal places." A half-cent is allowed either way, because a
 * value of exactly 0.015 is 0.01 or 0.02 depending on the rounding mode and
 * nothing in this feature should depend on which.
 */
const HALF_CENT = 0.005 + 1e-9;
function expectToTwoDecimals(actual: number | null, expected: number, label: string): void {
  expect(actual, label).not.toBeNull();
  expect(Math.abs((actual ?? Number.NaN) - expected), label).toBeLessThanOrEqual(HALF_CENT);
}

/** Deterministic PRNG. A randomized bound must fail the same way every time. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── The rubric at the end of the season ─────────────────────────────────────

describe('the rubric, exactly, at the end of the season', () => {
  /**
   * The best test this feature has. Once the final poll is published, FPI's
   * probabilities are 0 or 1 and the weight on the current fact is total, so the
   * projection stops being a projection and becomes the score. `seasonProgress`
   * deliberately never returns 1 (the final poll follows the bowls), which is
   * why `projectTeamAtWeight` exists.
   */
  const atTheEnd = (inputs: ProjectionInputs): TeamProjection => projectTeamAtWeight(inputs, 1);

  it('pays a power-four national champion the stated 12', () => {
    const projection = atTheEnd(
      inputsFor({
        winTitle: 1,
        makeTitleGame: 1,
        makePlayoffs: 1,
        conference: POWER_FOUR(1, 1),
        ranking: ranked(1),
      }),
    );

    expect(formatPoints(projection.total ?? Number.NaN)).toBe('12.00');
    expect(projection.total).toBe(MAX_POINTS);
    expect(projection.complete).toBe(true);
  });

  it('pays a national runner-up who won its conference the stated 11', () => {
    const projection = atTheEnd(
      inputsFor({
        winTitle: 0,
        makeTitleGame: 1,
        makePlayoffs: 1,
        conference: POWER_FOUR(1, 1),
        ranking: ranked(5),
      }),
    );

    // 0 + 4 (lost the title game) + 3 (playoff) + 3 (conference) + 0 + 1.
    expect(formatPoints(projection.total ?? Number.NaN)).toBe('11.00');
  });

  it('charges an unranked team with nothing the stated −1', () => {
    const projection = atTheEnd(
      inputsFor({ fpiRank: 100, conference: POWER_FOUR(0, 0), ranking: UNRANKED }),
    );

    expect(formatPoints(projection.total ?? Number.NaN)).toBe('-1.00');
    expect(projection.total).toBe(MIN_POINTS);
  });

  it.each([
    ['playoff, conference runner-up, finishes ranked', 0, 0, 1, 0, 1, true, 6],
    ['playoff only, finishes ranked', 0, 0, 1, 0, 0, true, 4],
    ['conference champion, no playoff, finishes ranked', 0, 0, 0, 1, 1, true, 4],
    ['conference runner-up, finishes unranked', 0, 0, 0, 0, 1, false, 1],
  ])(
    'compounds the rubric for %s',
    (_label, winTitle, makeTitleGame, makePlayoffs, win, reach, finishesRanked, expected) => {
      const projection = atTheEnd(
        inputsFor({
          winTitle,
          makeTitleGame,
          makePlayoffs,
          fpiRank: 100,
          conference: POWER_FOUR(win, reach),
          ranking: finishesRanked ? ranked(12) : UNRANKED,
        }),
      );

      expect(projection.total).toBeCloseTo(expected, 10);
    },
  );

  it('converges on the score as the season runs out', () => {
    const inputs = inputsFor({
      winTitle: 1,
      makeTitleGame: 1,
      makePlayoffs: 1,
      conference: POWER_FOUR(1, 1),
      ranking: ranked(1),
    });

    const weights = [0, 0.25, 0.5, 0.8, 0.95, 1];
    const totals = weights.map((weight) => projectTeamAtWeight(inputs, weight).total ?? Number.NaN);

    for (let index = 1; index < totals.length; index += 1) {
      expect(totals[index] as number).toBeGreaterThan(totals[index - 1] as number);
    }
    expect(totals[totals.length - 1]).toBe(MAX_POINTS);
  });
});

describe('the ceiling and the floor', () => {
  it('stays inside −1 and 12 over randomized valid inputs', () => {
    const random = mulberry32(0xc0ffee);

    for (let round = 0; round < 2000; round += 1) {
      // Nested the way the publishers' own numbers are: a ≤ b ≤ c, d ≤ e.
      const a = random();
      const b = a + (1 - a) * random();
      const c = b + (1 - b) * random();
      const d = random();
      const e = d + (1 - d) * random();

      const isRanked = random() < 0.3;
      const projection = projectTeamAtWeight(
        inputsFor({
          winTitle: a,
          makeTitleGame: b,
          makePlayoffs: c,
          fpiRank: 1 + Math.floor(random() * 200),
          conference: random() < 0.6 ? POWER_FOUR(d, e) : NOT_POWER_FOUR,
          ranking: isRanked ? ranked(1 + Math.floor(random() * POLL_SIZE)) : UNRANKED,
        }),
        random(),
      );

      const total = projection.total ?? Number.NaN;
      expect(Number.isFinite(total)).toBe(true);
      expect(total).toBeGreaterThanOrEqual(MIN_POINTS - 1e-9);
      expect(total).toBeLessThanOrEqual(MAX_POINTS + 1e-9);
    }
  });

  it('stays inside the bounds even when the inputs are NOT nested', () => {
    // A publisher could in principle publish P(title) > P(title game). The bound
    // must not depend on the nesting holding.
    const random = mulberry32(0x5eed);

    for (let round = 0; round < 500; round += 1) {
      const projection = projectTeamAtWeight(
        inputsFor({
          winTitle: random(),
          makeTitleGame: random(),
          makePlayoffs: random(),
          fpiRank: 1 + Math.floor(random() * 200),
          conference: POWER_FOUR(random(), random()),
          ranking: random() < 0.5 ? ranked(1 + Math.floor(random() * POLL_SIZE)) : UNRANKED,
        }),
        random(),
      );

      const total = projection.total ?? Number.NaN;
      expect(total).toBeGreaterThanOrEqual(MIN_POINTS - 1e-9);
      expect(total).toBeLessThanOrEqual(MAX_POINTS + 1e-9);
    }
  });
});

// ─── The differences must never go negative ──────────────────────────────────

describe('the runner-up terms are floored differences', () => {
  it('floors a negative title-game difference at zero and records the anomaly', () => {
    const projection = projectTeamAtWeight(
      // A publisher's rounding has put P(title) above P(title game).
      inputsFor({ winTitle: 0.42, makeTitleGame: 0.4, makePlayoffs: 0.9, ranking: ranked(3) }),
      0.5,
    );

    const term = termOf(projection, 'national_runner_up');
    expect(term.state).toBe('known');
    expect(term.probability).toBe(0);
    expect(term.contribution).toBe(0);
    expect(projection.anomalies).toEqual([
      expect.objectContaining({ kind: 'negative_difference', outcome: 'national_runner_up' }),
    ]);
  });

  it('floors a negative conference difference the same way', () => {
    const projection = projectTeamAtWeight(
      inputsFor({ conference: POWER_FOUR(0.3, 0.28), ranking: ranked(9) }),
      0.5,
    );

    const term = termOf(projection, 'conference_runner_up');
    expect(term.probability).toBe(0);
    expect(term.contribution).toBe(0);
    expect(projection.anomalies.map((anomaly) => anomaly.outcome)).toContain(
      'conference_runner_up',
    );
  });

  it('never produces a negative probability anywhere', () => {
    const random = mulberry32(0xbadbeef);

    for (let round = 0; round < 500; round += 1) {
      const projection = projectTeamAtWeight(
        inputsFor({
          winTitle: random(),
          makeTitleGame: random(),
          makePlayoffs: random(),
          fpiRank: 1 + Math.floor(random() * 150),
          conference: POWER_FOUR(random(), random()),
          ranking: UNRANKED,
        }),
        random(),
      );

      for (const term of projection.terms) {
        if (term.probability !== null) {
          expect(term.probability).toBeGreaterThanOrEqual(0);
          expect(term.probability).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('clamps an out-of-range probability and says so', () => {
    const projection = projectTeamAtWeight(
      inputsFor({ winTitle: 1.04, makePlayoffs: -0.2, ranking: ranked(1) }),
      0.5,
    );

    expect(termOf(projection, 'national_champion').probability).toBe(1);
    expect(termOf(projection, 'playoff').probability).toBe(0);
    expect(projection.anomalies.map((anomaly) => anomaly.kind)).toEqual([
      'probability_out_of_range',
      'probability_out_of_range',
      'negative_difference',
    ]);
  });

  it('discards a non-finite probability rather than putting NaN on screen', () => {
    const projection = projectTeamAtWeight(
      inputsFor({ winTitle: Number.NaN, makePlayoffs: 0.5, ranking: ranked(1) }),
      0.5,
    );

    expect(termOf(projection, 'national_champion').state).toBe('unavailable');
    expect(termOf(projection, 'national_runner_up').state).toBe('unavailable');
    expect(termOf(projection, 'playoff').state).toBe('known');
    expect(projection.complete).toBe(false);
    expect(Number.isFinite(projection.total)).toBe(true);
    expect(projection.anomalies[0]?.kind).toBe('probability_not_finite');
  });
});

// ─── Three states, never two ─────────────────────────────────────────────────

describe('a structural zero is not a missing number', () => {
  it('marks a non-power-four team not_eligible, with a contribution of 0', () => {
    const projection = projectTeamAtWeight(
      inputsFor({ makePlayoffs: 0.4, conference: NOT_POWER_FOUR, ranking: ranked(10) }),
      0.3,
    );

    for (const kind of ['conference_champion', 'conference_runner_up'] as const) {
      const term = termOf(projection, kind);
      expect(term.state).toBe('not_eligible');
      expect(term.contribution).toBe(0);
      expect(term.probability).toBeNull();
      expect(term.source).toBeNull();
    }
    // Nothing is missing, so the projection is still the whole rubric.
    expect(projection.complete).toBe(true);
  });

  it('marks a power-four team whose odds failed to load unavailable, with a null contribution', () => {
    const projection = projectTeamAtWeight(
      inputsFor({ makePlayoffs: 0.4, conference: ODDS_MISSING, ranking: ranked(10) }),
      0.3,
    );

    for (const kind of ['conference_champion', 'conference_runner_up'] as const) {
      const term = termOf(projection, kind);
      expect(term.state).toBe('unavailable');
      expect(term.contribution).toBeNull();
    }
    expect(projection.complete).toBe(false);
  });

  it('never renders the two the same way', () => {
    const base = { makePlayoffs: 0.4, ranking: ranked(10) };
    const notEligible = projectTeamAtWeight(
      inputsFor({ ...base, conference: NOT_POWER_FOUR }),
      0.3,
    );
    const unavailable = projectTeamAtWeight(inputsFor({ ...base, conference: ODDS_MISSING }), 0.3);

    const champion = (projection: TeamProjection) => termOf(projection, 'conference_champion');
    expect(champion(notEligible)).not.toEqual(champion(unavailable));
    expect(champion(notEligible).state).not.toBe(champion(unavailable).state);
    expect(champion(notEligible).contribution).not.toBe(champion(unavailable).contribution);
  });

  it('keeps every term in rubric order', () => {
    const projection = projectTeamAtWeight(inputsFor({}), 0.3);
    expect(projection.terms.map((term) => term.kind)).toEqual([...OUTCOME_ORDER]);
  });

  it('gives each term the rubric points for its outcome', () => {
    const projection = projectTeamAtWeight(inputsFor({}), 0.3);
    for (const term of projection.terms) {
      expect(term.points).toBe(RUBRIC[term.kind]);
    }
  });

  it('labels a mock projection as mock, never as a publisher (§46)', () => {
    const projection = projectTeamAtWeight(
      {
        providerTeamId: 'mock-1',
        fpi: {
          winTitle: 0.1,
          makeTitleGame: 0.2,
          makePlayoffs: 0.6,
          fpiRank: 8,
          source: 'mock_projection',
        },
        conference: {
          kind: 'odds',
          winConference: 0.2,
          reachConferenceGame: 0.4,
          source: 'mock_projection',
        },
        ranking: ranked(8),
        estimateSource: 'mock_projection',
      },
      0.3,
    );

    const sources = new Set(projection.terms.map((term) => term.source));
    expect(sources).toEqual(new Set(['mock_projection']));
  });
});

// ─── The one thing we model ──────────────────────────────────────────────────

describe('P(finishes in the final Top 25)', () => {
  it('anchors the rank model at #1 and #25', () => {
    expect(top25Baseline(ranked(1), null)).toBeCloseTo(TOP25_AT_1, 10);
    expect(top25Baseline(ranked(POLL_SIZE), null)).toBeCloseTo(TOP25_AT_25, 10);
  });

  it('falls monotonically across the poll', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let rank = 1; rank <= POLL_SIZE; rank += 1) {
      const value = top25Baseline(ranked(rank), null) ?? Number.NaN;
      expect(value).toBeLessThan(previous);
      previous = value;
    }
  });

  it('decays below the poll for an unranked team, from the #25 anchor', () => {
    expect(top25Baseline(UNRANKED, POLL_SIZE)).toBeCloseTo(TOP25_AT_25, 10);
    expect(top25Baseline(UNRANKED, POLL_SIZE + FPI_DECAY)).toBeCloseTo(
      TOP25_AT_25 * Math.exp(-1),
      10,
    );

    let previous = TOP25_AT_25 + 1;
    for (let fpiRank = POLL_SIZE; fpiRank <= 120; fpiRank += 5) {
      const value = top25Baseline(UNRANKED, fpiRank) ?? Number.NaN;
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it('caps an unranked team FPI likes at the #25 anchor, never above it', () => {
    expect(top25Baseline(UNRANKED, 10)).toBe(TOP25_AT_25);
    expect(top25Baseline(UNRANKED, 1)).toBe(TOP25_AT_25);
  });

  it('is unavailable with no poll rank AND no FPI rank — never a silent −1', () => {
    const projection = projectTeamAtWeight(
      inputsFor({ makePlayoffs: 0.1, fpiRank: null, ranking: UNRANKED }),
      0.3,
    );

    const term = termOf(projection, 'final_ranking');
    expect(term.state).toBe('unavailable');
    expect(term.contribution).toBeNull();
    expect(projection.complete).toBe(false);
    // The playoff term is intact, so the team still has a total — it is just
    // not the whole rubric, and `complete` says so.
    expect(projection.total).toBeCloseTo(0.3, 10);
    expect(projection.total).not.toBe(-1);
  });

  it('is unavailable when the poll itself failed, even if FPI ranks the team', () => {
    // The blend needs to know whether the team is ranked RIGHT NOW, and a failed
    // poll read is exactly what does not say.
    expect(top25Baseline(NO_POLL, 4)).toBeNull();
    expect(top25Probability({ ranking: NO_POLL, fpiRank: 4, seasonWeight: 0.3 })).toBeNull();
  });

  it('blends the model with the current fact, weighted by the season', () => {
    // Preseason: the model alone. End of season: the fact alone.
    expect(top25Probability({ ranking: ranked(25), fpiRank: null, seasonWeight: 0 })).toBeCloseTo(
      TOP25_AT_25,
      10,
    );
    expect(top25Probability({ ranking: ranked(25), fpiRank: null, seasonWeight: 1 })).toBe(1);
    expect(top25Probability({ ranking: UNRANKED, fpiRank: 60, seasonWeight: 1 })).toBe(0);
  });

  it('is the only term that can be negative, and it is shown as negative', () => {
    const projection = projectTeamAtWeight(
      inputsFor({ fpiRank: 90, conference: NOT_POWER_FOUR, ranking: UNRANKED }),
      0.5,
    );

    const term = termOf(projection, 'final_ranking');
    expect(term.contribution).toBeLessThan(0);
    for (const other of projection.terms.filter((candidate) => candidate !== term)) {
      expect(other.contribution ?? 0).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── Missing sources ─────────────────────────────────────────────────────────

describe('degrading, in labelled pieces', () => {
  it('leaves a team with no FPI row entirely unavailable rather than at zero', () => {
    const projection = projectTeamAtWeight(
      inputsFor({ fpi: null, conference: NOT_POWER_FOUR, ranking: UNRANKED }),
      0.3,
    );

    for (const kind of ['national_champion', 'national_runner_up', 'playoff'] as const) {
      expect(termOf(projection, kind).state).toBe('unavailable');
    }
    // Two structural zeros and four unknowns is not a 0.00 projection.
    expect(projection.total).toBeNull();
    expect(projection.complete).toBe(false);
  });

  it('still computes the finish term from the poll when FPI is gone', () => {
    const projection = projectTeamAtWeight(
      inputsFor({ fpi: null, conference: POWER_FOUR(0.2, 0.4), ranking: ranked(6) }),
      0.3,
    );

    expect(termOf(projection, 'final_ranking').state).toBe('known');
    expect(termOf(projection, 'conference_champion').state).toBe('known');
    expect(projection.total).not.toBeNull();
    expect(projection.complete).toBe(false);
  });

  it('refuses to total a team with nothing known at all', () => {
    const projection = projectTeamAtWeight(
      inputsFor({ fpi: null, conference: ODDS_MISSING, ranking: NO_POLL }),
      0.3,
    );

    expect(projection.terms.every((term) => term.state === 'unavailable')).toBe(true);
    expect(projection.total).toBeNull();
  });
});

// ─── A board ─────────────────────────────────────────────────────────────────

describe('projectBoard', () => {
  const teamWithTotal = (providerTeamId: string, makePlayoffs: number): TeamProjection =>
    projectTeamAtWeight(inputsFor({ providerTeamId, makePlayoffs, ranking: ranked(4) }), 0.3);

  it('counts the teams it could project, and says how many there were', () => {
    const projected = projectBoard([
      teamWithTotal('a', 0.5),
      teamWithTotal('b', 0.25),
      projectTeamAtWeight(
        inputsFor({ providerTeamId: 'fcs', fpi: null, conference: ODDS_MISSING, ranking: NO_POLL }),
        0.3,
      ),
    ]);

    expect(projected.teamsTotal).toBe(3);
    expect(projected.teamsCounted).toBe(2);
    expect(projected.teams).toHaveLength(3);
  });

  it('has no total when it could project nothing', () => {
    const projected = projectBoard([
      projectTeamAtWeight(
        inputsFor({ fpi: null, conference: ODDS_MISSING, ranking: NO_POLL }),
        0.3,
      ),
    ]);

    expect(projected.total).toBeNull();
    expect(projected.teamsCounted).toBe(0);
  });

  it('has no total for an empty board', () => {
    expect(projectBoard([]).total).toBeNull();
    expect(projectBoard([]).teamsTotal).toBe(0);
  });

  it('sums unrounded team totals', () => {
    const teams = [teamWithTotal('a', 0.5), teamWithTotal('b', 0.25)];
    const expected = (teams[0]?.total ?? 0) + (teams[1]?.total ?? 0);
    expect(projectBoard(teams).total).toBeCloseTo(expected, 12);
  });
});

// ─── Rounding is a display concern, and only happens once ────────────────────

describe('roundPoints and formatPoints', () => {
  it('never produces a negative zero', () => {
    for (const value of [-0.004, -0.0001, -0, -0.000000001]) {
      expect(formatPoints(value)).toBe('0.00');
      expect(Object.is(roundPoints(value), -0)).toBe(false);
    }
  });

  it('always shows two decimal places', () => {
    expect(formatPoints(5)).toBe('5.00');
    expect(formatPoints(-1)).toBe('-1.00');
    expect(formatPoints(5.7326667)).toBe('5.73');
    expect(formatPoints(-0.9187848)).toBe('-0.92');
  });
});

// ─── The worked examples, from the real numbers of 2026-09-30 ────────────────

/**
 * The eight teams of the plan's worked table. A change to a constant has to be
 * argued for against real teams rather than invented ones.
 *
 * Provenance, stated plainly because it matters when one of these fails:
 *
 * - The conference figures are playoffstatus's own whole percents, read on
 *   2026-09-30 from pages stamped Sep 26. `<1%` is read as 0.5%, which is why
 *   Texas A&M and Kansas carry 0.005.
 * - The FPI probabilities are reconstructed. The plan published each term
 *   rounded to 2 dp, not the underlying probability, so these are values inside
 *   the published interval; the assertion is therefore that every term matches
 *   the table to 2 dp AND the total matches the table's total, which is the
 *   property the table was actually demonstrating.
 * - `fpiRank` for the three unranked teams is solved back from the table's
 *   finish term, for the same reason. Kansas's is ~70. Nebraska's and Texas
 *   A&M's are pinned only to "25 or better": the baseline is capped at the
 *   `TOP25_AT_25` anchor inside the poll, so every rank from 1 to 25 reproduces
 *   the term and 26 onward reproduces none of it. Benign for Nebraska, whose 26%
 *   playoff odds fit a rank near 20. NOT benign for Texas A&M, whose same row
 *   carries 3% playoff odds while unranked — a team FPI ranks in its top 25 does
 *   not have 3% playoff odds, so that row is internally inconsistent. The table
 *   is the source, so it is reproduced and the oddity recorded, not smoothed
 *   over; Phase 2's captured FPI payload will settle it.
 */
const WORKED_SEASON: Season = { year: 2026, type: 'regular', week: 5 };

interface WorkedExample {
  team: string;
  providerTeamId: string;
  ranking: RankingState;
  fpiRank: number | null;
  winTitle: number;
  makeTitleGame: number;
  makePlayoffs: number;
  conference: ConferenceStanding;
  /** The table's six columns, in rubric order. */
  columns: readonly [number, number, number, number, number, number];
  /** The table's total, which comes from UNROUNDED terms. */
  total: string;
}

const WORKED_EXAMPLES: readonly WorkedExample[] = [
  {
    team: 'Texas',
    providerTeamId: '251',
    ranking: ranked(1),
    fpiRank: null,
    winTitle: 0.146,
    makeTitleGame: 0.2685,
    makePlayoffs: 0.892,
    conference: POWER_FOUR(0.19, 0.36),
    columns: [0.73, 0.49, 2.68, 0.57, 0.34, 0.93],
    total: '5.73',
  },
  {
    team: 'Miami',
    providerTeamId: '2390',
    ranking: ranked(4),
    fpiRank: null,
    winTitle: 0.102,
    makeTitleGame: 0.197,
    makePlayoffs: 0.8548,
    conference: POWER_FOUR(0.22, 0.42),
    columns: [0.51, 0.38, 2.56, 0.66, 0.4, 0.85],
    total: '5.37',
  },
  {
    team: 'Georgia',
    providerTeamId: '61',
    ranking: ranked(2),
    fpiRank: null,
    winTitle: 0.158,
    makeTitleGame: 0.278,
    makePlayoffs: 0.84,
    conference: POWER_FOUR(0.11, 0.23),
    columns: [0.79, 0.48, 2.52, 0.33, 0.24, 0.9],
    total: '5.26',
  },
  {
    team: 'Notre Dame',
    providerTeamId: '87',
    ranking: ranked(3),
    fpiRank: null,
    winTitle: 0.142,
    makeTitleGame: 0.257,
    makePlayoffs: 0.8467,
    conference: NOT_POWER_FOUR,
    columns: [0.71, 0.46, 2.54, 0, 0, 0.88],
    total: '4.59',
  },
  {
    team: 'Boise State',
    providerTeamId: '68',
    ranking: ranked(22),
    fpiRank: null,
    winTitle: 0.002,
    makeTitleGame: 0.007,
    makePlayoffs: 0.336,
    conference: NOT_POWER_FOUR,
    columns: [0.01, 0.02, 1.01, 0, 0, 0.41],
    total: '1.45',
  },
  {
    team: 'Nebraska',
    providerTeamId: '158',
    ranking: UNRANKED,
    fpiRank: 20,
    winTitle: 0.008,
    makeTitleGame: 0.023,
    makePlayoffs: 0.258,
    conference: POWER_FOUR(0.11, 0.22),
    columns: [0.04, 0.06, 0.77, 0.33, 0.22, -0.19],
    total: '1.23',
  },
  {
    team: 'Texas A&M',
    providerTeamId: '245',
    ranking: UNRANKED,
    fpiRank: 25,
    winTitle: 0.002,
    makeTitleGame: 0.0045,
    makePlayoffs: 0.03,
    conference: POWER_FOUR(0.005, 0.005),
    columns: [0.01, 0.01, 0.09, 0.01, 0, -0.19],
    total: '-0.07',
  },
  {
    team: 'Kansas',
    providerTeamId: '2305',
    ranking: UNRANKED,
    fpiRank: 70,
    winTitle: 0,
    makeTitleGame: 0,
    makePlayoffs: 0,
    conference: POWER_FOUR(0.005, 0.005),
    columns: [0, 0, 0, 0.01, 0, -0.93],
    total: '-0.92',
  },
];

function projectWorked(example: WorkedExample): TeamProjection {
  return projectTeam(
    {
      providerTeamId: example.providerTeamId,
      fpi: {
        winTitle: example.winTitle,
        makeTitleGame: example.makeTitleGame,
        makePlayoffs: example.makePlayoffs,
        fpiRank: example.fpiRank,
        source: 'espn_fpi',
      },
      conference: example.conference,
      ranking: example.ranking,
      estimateSource: 'espn_poll_estimate',
    },
    WORKED_SEASON,
  );
}

describe('the worked examples of 2026-09-30', () => {
  it('uses the week-5 weight the table was computed at', () => {
    expect(seasonProgress(WORKED_SEASON)).toBeCloseTo(0.8 * (5 / 15), 10);
  });

  it.each(WORKED_EXAMPLES.map((example) => [example.team, example] as const))(
    'reproduces %s',
    (team, example) => {
      const projection = projectWorked(example);

      OUTCOME_ORDER.forEach((kind, index) => {
        const term = termOf(projection, kind);
        const expected = example.columns[index] ?? Number.NaN;
        expectToTwoDecimals(term.contribution, expected, `${team} ${kind}`);
      });

      expect(formatPoints(projection.total ?? Number.NaN), `${team} total`).toBe(example.total);
    },
  );

  it('spreads the way the sanity check expects: a playoff team near 5–6 of 12, a bad year near 0', () => {
    const totals = new Map(
      WORKED_EXAMPLES.map((example) => [example.team, projectWorked(example).total ?? Number.NaN]),
    );

    expect(totals.get('Texas') ?? 0).toBeGreaterThan(5);
    expect(totals.get('Texas') ?? 0).toBeLessThan(6);
    expect(totals.get('Texas A&M') ?? 1).toBeLessThan(0);
    expect(totals.get('Kansas') ?? 1).toBeLessThan(0);
    expect(totals.get('Kansas') ?? 0).toBeGreaterThan(MIN_POINTS);
  });

  it('scores a board from unrounded totals, which is NOT the sum of the rounded ones', () => {
    const projections = WORKED_EXAMPLES.map(projectWorked);
    const board = projectBoard(projections);

    const sumOfRounded = projections.reduce(
      (sum, projection) => sum + roundPoints(projection.total ?? 0),
      0,
    );

    expect(formatPoints(board.total ?? Number.NaN)).toBe('22.65');
    expect(formatPoints(sumOfRounded)).toBe('22.64');
    expect(board.teamsCounted).toBe(WORKED_EXAMPLES.length);
  });

  it('records no anomaly on real publisher numbers', () => {
    for (const example of WORKED_EXAMPLES) {
      expect(projectWorked(example).anomalies, example.team).toEqual([]);
    }
  });
});
