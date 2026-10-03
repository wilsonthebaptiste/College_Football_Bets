import type { ProjectedTerm } from '@cfb/shared';
import { describe, expect, it } from 'vitest';
import {
  BIG_TEN_STAMP,
  freshness,
  inputDown,
  projectedTeam,
  projectionSources,
  SEC_STAMP,
  WORKED_TEAMS,
} from '../test/fixtures';
import {
  coverageNote,
  formatChance,
  lineView,
  linesCounted,
  OUTCOME_LABELS,
  provenance,
} from './projection';

/**
 * Projected points, in words (predicting_score.md, Phase 4). Every sentence a
 * screen can show about a projection comes from here, so it is pinned here.
 */

function termOf(kind: ProjectedTerm['kind'], team = projectedTeam(WORKED_TEAMS[0]![1])) {
  const term = team.terms.find((candidate) => candidate.kind === kind);
  if (term === undefined) throw new Error(`no ${kind}`);
  return term;
}

describe('lineView — one rubric line', () => {
  it('prints a quoted line as its contribution, its chance and points, then its publisher', () => {
    const line = lineView(termOf('national_champion'));
    expect(line.value).toBe('0.73');
    expect(line.label).toBe('National champion');
    expect(line.detail).toBe('14.6% chance × 5 pts');
    expect(line.source).toBe('ESPN FPI');
    expect(line.tone).toBe('gain');
  });

  it('names the conference half’s own publisher, not FPI', () => {
    expect(lineView(termOf('conference_champion')).source).toBe('playoffstatus.com');
  });

  it('signs the finish line, names the unranked rule, and calls the figure ours', () => {
    const texas = lineView(termOf('final_ranking'));
    expect(texas.value).toBe('+0.93');
    expect(texas.detail).toContain('+1 if it does, −1 if not');
    expect(texas.source).toBe('Our estimate, from the current poll');
    expect(texas.source).not.toContain('ESPN');

    const kansas = lineView(termOf('final_ranking', projectedTeam(WORKED_TEAMS[7]![1])));
    expect(kansas.value).toBe('−0.93');
    expect(kansas.tone).toBe('loss');
  });

  it('prints the contribution as given, never points × probability, for the finish line', () => {
    // Recomputing it would print 1 × p = +0.04 for Kansas and drop the −1 line.
    const kansas = termOf('final_ranking', projectedTeam(WORKED_TEAMS[7]![1]));
    expect(lineView(kansas).value).not.toBe('0.04');
    expect(lineView(kansas).value).toBe('−0.93');
  });

  it('keeps a structural zero and an unknown apart: 0.00 with a reason, and a dash (§7)', () => {
    const notreDame = projectedTeam(WORKED_TEAMS[3]![1]);
    const ineligible = lineView(termOf('conference_champion', notreDame));
    expect(ineligible.value).toBe('0.00');
    expect(ineligible.detail).toBe('Not in a power-four conference');
    expect(ineligible.source).toBeNull();

    const missing = lineView(
      termOf(
        'conference_champion',
        projectedTeam([0, 0, 0, 0, 0, 0], {
          unavailable: ['conference_champion'],
        }),
      ),
    );
    expect(missing.value).toBe('—');
    expect(missing.spokenValue).toBe('Unavailable');
    expect(missing.detail).toBe('No conference odds for this team');
    expect(missing.value).not.toBe(ineligible.value);
    expect(missing.tone).not.toBe(ineligible.tone);
  });

  it('reads FPI’s stand-in runner-up zero as "does not say", not "no chance"', () => {
    const fallback = projectedTeam([0.73, 0.49, 2.68, 0.91, 0, 0.93], {
      conferenceSource: 'espn_fpi',
    });
    const runnerUp = lineView(termOf('conference_runner_up', fallback));
    expect(runnerUp.value).toBe('0.00');
    expect(runnerUp.detail).toContain('ESPN FPI publishes no runner-up odds');
    expect(runnerUp.detail).not.toMatch(/0(\.0)?% chance/);
    expect(lineView(termOf('conference_champion', fallback)).source).toBe('ESPN FPI');
  });

  it('labels every outcome', () => {
    expect(Object.keys(OUTCOME_LABELS)).toHaveLength(6);
  });
});

describe('formatChance', () => {
  it('never prints 0% for a real chance or 100% for an uncertain one', () => {
    expect(formatChance(0.0002)).toBe('<0.1%');
    expect(formatChance(0)).toBe('0%');
    expect(formatChance(0.9999)).toBe('>99.9%');
    expect(formatChance(1)).toBe('100%');
    expect(formatChance(0.893)).toBe('89.3%');
  });
});

describe('linesCounted and coverageNote', () => {
  it('counts known lines and structural zeros, never the dashes', () => {
    expect(linesCounted(projectedTeam(WORKED_TEAMS[3]![1]).terms)).toBe(6);
    expect(
      linesCounted(projectedTeam([0, 0, 0, 0, 0, 0.1], { unavailable: ['playoff'] }).terms),
    ).toBe(5);
  });

  it('says how much of a board is behind its number, and nothing when it is all of it', () => {
    expect(coverageNote(5, 6)).toBe('from 5 of 6 teams');
    expect(coverageNote(6, 6)).toBeNull();
    expect(coverageNote(0, 0)).toBeNull();
  });
});

describe('provenance — "Projection · as of …"', () => {
  it('names both publishers with their own stamps, and the four pages’ split, on a board', () => {
    const { asOf, problems } = provenance(projectionSources());
    expect(asOf).toMatch(/^Projection · as of Sep 30 \(ESPN FPI\) and /);
    expect(asOf).toContain(`${SEC_STAMP} for SEC and Big 12`);
    expect(asOf).toContain(`${BIG_TEN_STAMP} for Big Ten and ACC (playoffstatus.com)`);
    expect(asOf).not.toMatch(/live/i);
    expect(problems).toEqual([]);
  });

  it('dates a team by its own conference’s page, and only that one', () => {
    const { asOf } = provenance(projectionSources(), 'Big Ten');
    expect(asOf).toBe(
      `Projection · as of Sep 30 (ESPN FPI) and ${BIG_TEN_STAMP} (playoffstatus.com)`,
    );
  });

  it('leaves the odds publisher out for a team its pages do not cover', () => {
    expect(provenance(projectionSources(), null).asOf).toBe('Projection · as of Sep 30 (ESPN FPI)');
    expect(provenance(projectionSources(), 'Mountain West').asOf).not.toContain('playoffstatus');
  });

  it('uses the one stamp when all four pages agree', () => {
    const { asOf } = provenance(
      projectionSources({ conference_odds: { computedLabel: SEC_STAMP } }),
    );
    expect(asOf).toBe(`Projection · as of Sep 30 (ESPN FPI) and ${SEC_STAMP} (playoffstatus.com)`);
  });

  it('says which publisher could not be reached, and never dates what it does not have', () => {
    const { asOf, problems } = provenance(projectionSources({ conference_odds: inputDown() }));
    expect(asOf).toBe('Projection · as of Sep 30 (ESPN FPI) and conference odds unavailable');
    expect(problems).toEqual([
      'Couldn’t load the conference odds. The lines that depend on it say so.',
    ]);
  });

  it('names both when both are down', () => {
    const { asOf, problems } = provenance(
      projectionSources({ fpi: inputDown(), conference_odds: inputDown() }),
    );
    expect(asOf).toBe('Projection · as of ESPN FPI unavailable and conference odds unavailable');
    expect(problems[0]).toContain('ESPN FPI and the conference odds');
  });

  it('says when an input is being served from an older copy', () => {
    const { problems } = provenance(
      projectionSources({ rankings: { freshness: freshness('stale') } }),
    );
    expect(problems).toEqual(['The poll may be out of date.']);
  });

  /**
   * Production's settings on 2026-10-02: real FPI, and the odds publisher still
   * `mock` until Phase 5 flips it. The mock pages' stamp is a sentence, and it
   * must not be printed where a date goes.
   */
  it('names a mock half as mock when the other half is real', () => {
    const mock = {
      source: 'mock_projection' as const,
      computedLabel: 'Mock projection (synthetic data)',
      pages: [{ conference: 'SEC', computedLabel: 'Mock projection (synthetic data)' }],
    };
    const board = provenance(projectionSources({ conference_odds: mock }));
    expect(board.asOf).toBe('Projection · as of Sep 30 (ESPN FPI) and mock data (conference odds)');
    expect(provenance(projectionSources({ conference_odds: mock }), 'SEC').asOf).toBe(board.asOf);
    expect(provenance(projectionSources({ fpi: mock })).asOf).toMatch(
      /^Projection · as of mock data \(national odds\) and Sat Sep 26/,
    );
  });

  it('calls mock figures mock, and gives them no date to look real by (§46)', () => {
    const mock = {
      source: 'mock_projection' as const,
      computedLabel: 'Mock projection (synthetic data)',
    };
    const { asOf } = provenance(projectionSources({ fpi: mock, conference_odds: mock }));
    expect(asOf).toBe('Projection · mock data: synthetic figures, not from any publisher');
    expect(asOf).not.toContain('as of');
  });
});
