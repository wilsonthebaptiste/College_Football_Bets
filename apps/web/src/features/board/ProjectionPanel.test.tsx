import type { BoardProjectionResponse, BoardResponse } from '@cfb/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../lib/api';
import { ApiError } from '../../lib/apiClient';
import {
  boardProjection,
  envelope,
  inputDown,
  makeBoard,
  makeBoardTeam,
  makeSnapshot,
  makeTeam,
  projectedEntry,
  projectedTeam,
  projectionSources,
  unprojectedTeam,
  WORKED_TEAMS,
} from '../../test/fixtures';
import { RAW_VALUE, renderAt, spokenText, visibleText } from '../../test/render';
import { BoardPage } from './BoardPage';

/**
 * The board's projected points panel (predicting_score.md, Phase 4): the
 * board's total, one row per team, each opening to its six rubric lines — and
 * a board that is exactly as it was when the projection is slow or broken.
 */

const USER_ID = '22222222-2222-4222-8222-000000000001';

function sixTeamBoard(): BoardResponse {
  return makeBoard(
    WORKED_TEAMS.slice(0, 6).map(([name], index) => {
      const team = makeTeam({ displayName: name });
      return makeBoardTeam(envelope(makeSnapshot(team)), team, index + 1);
    }),
    { user: { id: USER_ID, displayName: 'Wilson' } },
  );
}

/** The plan's eight worked teams of 2026-09-30, on one board. */
function workedProjection(overrides: Partial<BoardProjectionResponse> = {}) {
  return boardProjection(
    WORKED_TEAMS.map(([name, contributions, total], index) =>
      projectedEntry(name, projectedTeam(contributions, { total }), index + 1),
    ),
    overrides,
  );
}

type Seed = BoardProjectionResponse | ApiError | undefined;

function renderBoard(projection: Seed, board: BoardResponse = sixTeamBoard()) {
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  client.setQueryData(queryKeys.board(USER_ID), board);
  const key = queryKeys.boardProjection(USER_ID);
  if (projection instanceof ApiError) {
    client.getQueryCache().build(client, { queryKey: key }).setState({
      status: 'error',
      error: projection,
      errorUpdatedAt: Date.now(),
      fetchStatus: 'idle',
    });
  } else if (projection !== undefined) {
    client.setQueryData(key, projection);
  }
  const markup = renderAt(`/u/${USER_ID}`, '/u/:userId', <BoardPage />, client);
  const panel =
    markup.match(
      /<section[^>]*>(?:(?!<section).)*?<h2[^>]*>Projected points<\/h2>.*<\/section>/,
    )?.[0] ?? '';
  return { markup, panel, seen: visibleText(markup), heard: spokenText(markup), client };
}

/** The summary row of each team, as text. */
function rows(panel: string): string[] {
  return [...panel.matchAll(/<summary[^>]*>(.*?)<\/summary>/g)].map(([, inner]) =>
    visibleText(inner ?? ''),
  );
}

/** Each team's opened lines, as printed values. */
function lineValues(panel: string): string[][] {
  return [...panel.matchAll(/<details[^>]*>.*?<\/details>/g)].map(([details]) =>
    [...details.matchAll(/<li[^>]*><span class="[^"]*">(.*?)<\/span>/g)].map(([, value]) =>
      visibleText(value ?? ''),
    ),
  );
}

const parse = (text: string): number => Number(text.replace('−', '-'));

describe('the board’s total and its teams', () => {
  const { markup, panel, seen } = renderBoard(workedProjection());

  it('sits below the six cards, under its own h2, with the page’s one h1', () => {
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(seen.indexOf('Projected points')).toBeGreaterThan(seen.lastIndexOf('Next'));
    expect(markup.match(/<h2[^>]*>Projected points<\/h2>/g)).toHaveLength(1);
  });

  it('prints the board total as the API rounded it: 22.65', () => {
    expect(visibleText(panel)).toMatch(/^Projected points 22\.65 projected points/);
  });

  it('lists every team, number first, in board order', () => {
    expect(rows(panel)).toEqual([
      '5.73 Texas',
      '5.37 Miami',
      '5.26 Georgia',
      '4.59 Notre Dame',
      '1.45 Boise State',
      '1.23 Nebraska',
      '−0.07 Texas A&M',
      '−0.92 Kansas',
    ]);
  });

  /**
   * The exit criterion asked for the printed rows to add up to the printed
   * total. On the plan's own eight teams they cannot: the rows sum to 22.64
   * and the board, summed unrounded and rounded once, is 22.65. Rendering the
   * API's total and saying why is the honest choice (Phase 3's handoff), so the
   * test pins both halves of it.
   */
  it('does not pretend the printed rows add up, and says why', () => {
    const printed = rows(panel).map((row) => parse(row.split(' ')[0] ?? ''));
    const summed = Math.round(printed.reduce((a, b) => a + b, 0) * 100) / 100;
    expect(summed).toBe(22.64);
    expect(visibleText(panel)).toContain('22.65');
    expect(visibleText(panel)).toContain(
      'Totals are added up before rounding, so the figures above can differ from them by a cent.',
    );
  });

  it('opens each team to its six lines, and their printed values come within rounding of its total', () => {
    const teams = lineValues(panel);
    expect(teams).toHaveLength(8);
    for (const [index, values] of teams.entries()) {
      expect(values).toHaveLength(6);
      const total = WORKED_TEAMS[index]![2];
      const summed = values.reduce(
        (sum, value) => sum + (Number.isNaN(parse(value)) ? 0 : parse(value)),
        0,
      );
      // Six lines each rounded to the cent: at most three cents from a total
      // rounded once. Texas is the plan's own example — 5.74 printed, 5.73 total.
      expect(Math.abs(summed - total)).toBeLessThanOrEqual(0.03);
    }
    expect(teams[0]).toEqual(['0.73', '0.49', '2.68', '0.57', '0.34', '+0.93']);
  });

  it('shows the negative finish line as negative, with the unranked rule named', () => {
    expect(lineValues(panel)[7]?.[5]).toBe('−0.93');
    expect(visibleText(panel)).toContain('+1 if it does, −1 if not');
  });

  it('pays the independents a structural 0.00 with a reason — which no dash resembles', () => {
    expect(lineValues(panel)[3]).toEqual(['0.71', '0.46', '2.54', '0.00', '0.00', '+0.88']);
    expect(visibleText(panel)).toContain('Not in a power-four conference');
    expect(panel).not.toContain('—');
  });

  it('names the publishers once, with the pages’ own stamps and our estimate as ours', () => {
    const text = visibleText(panel);
    expect(text.match(/Not a result\./g)).toHaveLength(1);
    expect(text).toContain('Top-25 finish estimated from the current poll.');
    expect(text).toContain('Projection · as of Sep 30 (ESPN FPI)');
    expect(text).toContain('Sat Sep 26 11:30 pm for SEC and Big 12');
    expect(text).toContain('Our estimate, from the current poll');
  });

  it('is never a bare table of decimals, never "live", and never a raw value', () => {
    expect(panel).not.toContain('<table');
    expect(visibleText(panel)).not.toMatch(/\blive\b|\bscore\b/i);
    expect(visibleText(panel)).not.toMatch(RAW_VALUE);
    expect(visibleText(panel)).not.toContain('-0.00');
    expect(spokenText(panel)).not.toMatch(RAW_VALUE);
  });

  it('opens a team with a native, keyboard-ready control', () => {
    expect(panel.match(/<details/g)).toHaveLength(8);
    expect(panel.match(/<summary/g)).toHaveLength(8);
  });
});

describe('reading order: the number, then what it means, then the source', () => {
  const { panel } = renderBoard(workedProjection());
  const heard = spokenText(panel);

  it('for the board', () => {
    expect(heard.indexOf('22.65')).toBeLessThan(heard.indexOf('Expected points'));
    expect(heard.indexOf('Expected points')).toBeLessThan(heard.indexOf('Projection · as of'));
  });

  it('for a team row, which says the number is points', () => {
    expect(heard).toContain('5.73 points: Texas');
  });

  it('for a line', () => {
    const line = heard.slice(heard.indexOf('0.73 National champion'));
    expect(line.startsWith('0.73 National champion 14.6% chance × 5 pts ESPN FPI')).toBe(true);
  });
});

describe('every state renders cleanly, with one h1 and no raw value', () => {
  function expectClean(markup: string): void {
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(visibleText(markup)).not.toMatch(RAW_VALUE);
    expect(spokenText(markup)).not.toMatch(RAW_VALUE);
    expect(visibleText(markup)).not.toContain('-0.00');
  }

  it('while loading, with the board fully drawn and the wait announced', () => {
    const { markup, panel, heard } = renderBoard(undefined);
    expect(heard).toContain('Loading projected points…');
    expect(markup.match(/<article/g)).toHaveLength(6);
    expect(visibleText(panel)).toBe('Projected points');
    expectClean(markup);
  });

  it('when both publishers are down: no total, no zeros, and both named', () => {
    const projection = boardProjection(
      WORKED_TEAMS.slice(0, 6).map(([name], index) =>
        projectedEntry(name, unprojectedTeam(), index + 1),
      ),
      { sources: projectionSources({ fpi: inputDown(), conference_odds: inputDown() }) },
    );
    const { markup, panel } = renderBoard(projection);
    const text = visibleText(panel);
    expect(text).toContain('No projected total.');
    expect(text).toContain('Couldn’t load ESPN FPI and the conference odds.');
    expect(text).not.toMatch(/\d\.\d\d/);
    expect(rows(panel)[0]).toBe('— Texas not projected');
    expect(markup.match(/<article/g)).toHaveLength(6);
    expectClean(markup);
  });

  it('when the odds publisher is down: FPI stands in for the champion line, labelled, and says what it cannot', () => {
    const fallback = projectedTeam([0.73, 0.49, 2.68, 0.91, 0, 0.93], {
      conferenceSource: 'espn_fpi',
    });
    const projection = boardProjection([projectedEntry('Texas', fallback)], {
      sources: projectionSources({ conference_odds: inputDown() }),
      freshness: { ...workedProjection().freshness, state: 'stale' },
    });
    const { markup, panel } = renderBoard(projection);
    const text = visibleText(panel);
    expect(text).toContain('0.91 Conference champion 30.3% chance × 3 pts ESPN FPI');
    expect(text).toContain('ESPN FPI publishes no runner-up odds');
    expect(text).toContain('Couldn’t load the conference odds.');
    expect(text).toContain('conference odds unavailable');
    expectClean(markup);
  });

  it('with a team no publisher covers: "from 5 of 6 teams", a dash row, never a zero', () => {
    const entries = WORKED_TEAMS.slice(0, 5).map(([name, contributions, total], index) =>
      projectedEntry(name, projectedTeam(contributions, { total }), index + 1),
    );
    entries.push(projectedEntry('Mercer', unprojectedTeam(), 6));
    const { markup, panel } = renderBoard(boardProjection(entries));
    expect(visibleText(panel)).toMatch(/projected points from 5 of 6 teams/);
    expect(rows(panel)[5]).toBe('— Mercer not projected');
    expect(lineValues(panel)[5]).toEqual(['—', '—', '—', '—', '—', '—']);
    expect(spokenText(panel)).toContain('Unavailable National champion');
    expectClean(markup);
  });

  it('with a partial team: its total, and how many of its six lines are behind it', () => {
    const partial = projectedTeam([0, 0, 0, 0.42, 0.3, -0.5], {
      unavailable: ['national_champion', 'national_runner_up', 'playoff'],
    });
    const { panel } = renderBoard(boardProjection([projectedEntry('Texas Tech', partial)]));
    expect(rows(panel)[0]).toBe('0.22 Texas Tech 3 of 6 lines');
  });

  it('with no teams on the board: no panel at all', () => {
    const { markup, seen } = renderBoard(
      workedProjection(),
      makeBoard([], { user: { id: USER_ID, displayName: 'Wilson' } }),
    );
    expect(seen).toContain('No teams yet');
    expect(markup).not.toContain('Projected points');
    expectClean(markup);
  });

  it.each([
    [
      'a failed request',
      new ApiError(
        { kind: 'internal', message: 'Something went wrong on the server.', requestId: 'r-b1' },
        500,
      ),
      'Something went wrong on the server.',
    ],
    [
      'a 429',
      new ApiError(
        {
          kind: 'rate_limited',
          message: 'Too many requests. Wait a moment and try again.',
          requestId: 'r-b2',
        },
        429,
      ),
      'Too many requests. Wait a moment and try again.',
    ],
  ])('after %s: the board intact, the reason, a retry, and the reference', (_, error, message) => {
    const { markup, panel } = renderBoard(error);
    const text = visibleText(panel);
    expect(text).toContain('Projected points unavailable');
    expect(text).toContain(message);
    expect(text).toContain('The board above is unaffected.');
    expect(text).toContain('Try again');
    expect(text).toContain(`Reference: ${error.requestId ?? ''}`);
    expect(markup.match(/<article/g)).toHaveLength(6);
    expect(markup).not.toContain('role="alert"');
    expectClean(markup);
  });

  it('while the board itself loads, starts the projection request alongside it', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
    const markup = renderAt(`/u/${USER_ID}`, '/u/:userId', <BoardPage />, client);
    expect(markup.match(/<h1/g)).toHaveLength(1);
    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys).toContainEqual(queryKeys.boardProjection(USER_ID));
  });
});
