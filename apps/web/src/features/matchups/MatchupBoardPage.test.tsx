import type { Matchup, MatchupBoardResponse } from '@cfb/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../lib/api';
import { ApiError } from '../../lib/apiClient';
import { formatKickoffTime } from '../../lib/format';
import {
  finalMatchup,
  freshness,
  JORDAN,
  liveMatchup,
  LONGEST_NAME,
  makeMatchup,
  makeTeam,
  matchupBoardResponse,
  PROVIDER_DOWN,
  STEPH,
  WILSON,
} from '../../test/fixtures';
import { RAW_VALUE, renderAt, spokenText, visibleText } from '../../test/render';
import { MatchupBoardPage } from './MatchupBoardPage';

/**
 * The matchup board's exit criteria (plan-matchup-board, Phase 2), rendered
 * for every state the plan names: loading, a failed request, a 429, a stale
 * row, a failed row, an empty week, the offseason, a live game with no score,
 * a TBD kickoff, a postponed game, a same-owner game, and a two-owner side.
 * Each test seeds the query cache with exactly what the API would answer.
 */

type Seed = MatchupBoardResponse | ApiError | undefined;

function renderBoard(seed: Seed, path = '/matchups?week=6') {
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const week = new URL(path, 'http://x').searchParams.get('week');
  const key = queryKeys.matchupBoard(week);
  if (seed instanceof ApiError) {
    client.getQueryCache().build(client, { queryKey: key }).setState({
      status: 'error',
      error: seed,
      errorUpdatedAt: Date.now(),
      fetchStatus: 'idle',
    });
  } else if (seed !== undefined) {
    client.setQueryData(key, seed);
  }
  const markup = renderAt(path, '/matchups', <MatchupBoardPage />, client);
  return { markup, seen: visibleText(markup), heard: spokenText(markup) };
}

function headings(markup: string): string[] {
  return [...markup.matchAll(/<(h[1-4])[^>]*>(.*?)<\/\1>/g)].map(
    ([, level, inner]) => `${level ?? ''}:${visibleText(inner ?? '')}`,
  );
}

/** Every `<a>` in the markup, as `href text`. */
function links(markup: string): string[] {
  return [...markup.matchAll(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map(
    ([, href, inner]) => `${href ?? ''} ${visibleText(inner ?? '')}`,
  );
}

function expectClean(markup: string): void {
  expect(visibleText(markup)).not.toMatch(RAW_VALUE);
  expect(spokenText(markup)).not.toMatch(RAW_VALUE);
  expect(markup.match(/<h1/g)).toHaveLength(1);
}

/** A Saturday that has a bit of everything. */
function fullWeek(): MatchupBoardResponse {
  return matchupBoardResponse([
    liveMatchup(),
    makeMatchup(),
    makeMatchup({
      providerGameId: '401500010',
      kickoffUtc: '2026-10-10T04:00:00.000Z',
      kickoffTbd: true,
      broadcast: null,
    }),
    finalMatchup(),
    makeMatchup({ providerGameId: '401500011', status: 'postponed', statusDetail: 'Postponed' }),
  ]);
}

describe('a week of matchups: sections, in §51 order, under one h1', () => {
  const { markup, seen } = renderBoard(fullWeek());

  it('heads the page with the week, the season, the poll, and "Last updated"', () => {
    expect(headings(markup)[0]).toBe('h1:Week 6 matchups');
    expect(seen).toContain('2026 season Rankings: AP Top 25');
    expect(seen).not.toContain('2026 season, week 6');
    expect(seen).toContain('Rankings: AP Top 25');
    expect(seen).toContain('Last updated:');
  });

  it('runs Live now, Upcoming by day, Final, then Postponed and canceled', () => {
    const cardTitle = 'Ohio State at Iowa';
    expect(
      headings(markup).filter((heading) => /^h[23]:/.test(heading) && !heading.endsWith(cardTitle)),
    ).toEqual([
      'h2:Live now',
      'h2:Upcoming',
      'h3:Saturday, October 10',
      'h2:Final',
      'h2:Postponed and canceled',
    ]);
  });

  it('gives each card one heading and one link, the matchup, to its game page', () => {
    const cardLinks = links(markup).filter(([href]) => href !== undefined);
    expect(cardLinks.filter((link) => link.startsWith('/matchups/'))).toEqual([
      '/matchups/401500002 Ohio State at Iowa',
      '/matchups/401500001 Ohio State at Iowa',
      '/matchups/401500010 Ohio State at Iowa',
      '/matchups/401500003 Ohio State at Iowa',
      '/matchups/401500011 Ohio State at Iowa',
    ]);
    // No team or owner name is a link inside a card: nested links break keyboard order.
    expect(links(markup).some((link) => link.startsWith('/teams/') || link.startsWith('/u/'))).toBe(
      false,
    );
  });

  it('names both teams, their ranks and records, and whose board each is on', () => {
    expect(seen).toContain('Ohio State #2 5-0 Wilson');
    expect(seen).toContain('@ Iowa NR 3-2 Steph');
  });

  it('never renders a raw value, in seen or spoken text', () => {
    expectClean(markup);
  });
});

describe('the week links', () => {
  it('are real links to ?week=, printed with the calendar’s own labels', () => {
    const { markup } = renderBoard(fullWeek());
    expect(links(markup)).toEqual(
      expect.arrayContaining(['/matchups?week=5 Week 5', '/matchups?week=7 Week 7']),
    );
    expect(spokenText(markup)).toContain('Previous week: Week 5');
    expect(spokenText(markup)).toContain('Next week: Week 7');
  });

  it('come before every card, so Tab reaches them first', () => {
    const { markup } = renderBoard(fullWeek());
    expect(markup.indexOf('?week=7')).toBeLessThan(markup.indexOf('/matchups/401500002'));
  });

  it('offer no previous at the first week, and nothing at all with no calendar', () => {
    const first = renderBoard(
      matchupBoardResponse([makeMatchup()], { week: 5 }),
      '/matchups?week=5',
    );
    expect(links(first.markup).filter((link) => link.includes('?week='))).toEqual([
      '/matchups?week=6 Week 6',
    ]);
    const none = renderBoard(matchupBoardResponse([makeMatchup()], { weeks: [] }));
    expect(none.markup).not.toContain('aria-label="Weeks"');
    expect(headings(none.markup)[0]).toBe('h1:Week 6 matchups');
  });

  it('print a postseason week’s label, never "Week 999"', () => {
    const { markup } = renderBoard(
      matchupBoardResponse([makeMatchup()], {
        season: { year: 2026, type: 'postseason', week: 999 },
        week: 999,
        weeks: [
          { week: 1, label: 'Bowls', startUtc: '', endUtc: '' },
          { week: 999, label: 'CFP', startUtc: '', endUtc: '' },
        ],
      }),
      '/matchups?week=999',
    );
    expect(headings(markup)[0]).toBe('h1:CFP matchups');
    expect(links(markup)).toContain('/matchups?week=1 Bowls');
    expect(visibleText(markup)).not.toContain('999');
  });

  it('asks for the current week by leaving the week out, and dates nothing it does not know', () => {
    const { markup } = renderBoard(fullWeek(), '/matchups');
    expect(headings(markup)[0]).toBe('h1:Week 6 matchups');
  });
});

describe('a live game', () => {
  it('says LIVE, the provider’s situation, and the score’s own "Updated" time', () => {
    const { seen, markup } = renderBoard(matchupBoardResponse([liveMatchup()]));
    expect(seen).toContain('LIVE 4:32 - 2nd Quarter');
    expect(seen).toMatch(/Ohio State #2 5-0 Wilson 14/);
    expect(seen).toMatch(/@ Iowa NR 3-2 Steph 7/);
    expect(markup).toContain('dateTime="2026-10-10T21:41:00.000Z"');
    expect(seen).toContain('Updated');
  });

  it('is the only polite live region on the card, and it holds the scores only', () => {
    const { markup } = renderBoard(matchupBoardResponse([liveMatchup(), makeMatchup()]));
    // Exactly one per live card, and none on the upcoming card.
    expect(markup.match(/aria-live="polite"/g)).toHaveLength(1);
    const region = /aria-live="polite"[^>]*>(.*?)<\/div><\/div><\/div>/.exec(markup)?.[1] ?? '';
    expect(visibleText(region)).not.toContain('LIVE');
    expect(visibleText(region)).not.toContain('Updated');
  });

  it('puts real spaces between the pieces a screen reader reads', () => {
    const { heard } = renderBoard(matchupBoardResponse([liveMatchup()]));
    expect(heard).toContain('LIVE 4:32 - 2nd Quarter');
    expect(heard).toContain(
      'Ohio State Ranked 2 in the AP Top 25 Record 5-0 Picked by Wilson score 14',
    );
    expect(heard).toContain('at Iowa Not ranked Record 3-2 Picked by Steph score 7');
    expect(heard).not.toMatch(/LIVE\d|[a-z]\d{1,2}\b(?! -)/);
  });

  it('with no score, says so in words, never 0–0 (§4)', () => {
    const row = liveMatchup();
    const { seen, heard } = renderBoard(
      matchupBoardResponse([
        { ...row, away: { ...row.away, score: null }, home: { ...row.home, score: null } },
      ]),
    );
    expect(seen).toContain('Score unavailable');
    expect(seen).not.toMatch(/0–0|Wilson 0|Steph 0/);
    expect(heard).not.toContain('score ');
  });

  it('is never called Final while the provider says it is in progress (§11)', () => {
    const { seen } = renderBoard(matchupBoardResponse([liveMatchup({ statusDetail: 'Final' })]));
    expect(seen).not.toContain('Final');
    expect(seen).toContain('LIVE 2nd quarter, 4:32');
  });

  it('shows halftime and a mid-game delay in the provider’s own words', () => {
    const half = renderBoard(matchupBoardResponse([liveMatchup({ statusDetail: 'Halftime' })]));
    expect(half.seen).toContain('LIVE Halftime');
    const delayed = renderBoard(
      matchupBoardResponse([
        liveMatchup({ status: 'delayed', statusDetail: 'Weather delay', period: 3 }),
      ]),
    );
    expect(delayed.seen).toContain('Live now');
    expect(delayed.seen).toContain('Delayed Weather delay');
    expect(delayed.seen).not.toContain('LIVE');
  });
});

describe('a stale row and a failed row (§39, §42)', () => {
  it('a stale live row says it may be out of date, with its original time', () => {
    const { seen, markup } = renderBoard(
      matchupBoardResponse(
        [liveMatchup({ freshness: freshness('stale', '2026-10-10T21:30:00.000Z') })],
        {
          freshness: freshness('stale', '2026-10-10T17:59:00.000Z'),
        },
      ),
    );
    expect(seen).toContain('May be out of date. Last updated:');
    expect(markup).toContain('dateTime="2026-10-10T21:30:00.000Z"');
    // The score is still shown: stale is labelled, not hidden.
    expect(seen).toMatch(/Wilson 14/);
  });

  it('a failed row keeps both teams and says the score is temporarily unavailable', () => {
    const row = liveMatchup({ freshness: freshness('unavailable') });
    const { seen, markup } = renderBoard(
      matchupBoardResponse([
        { ...row, away: { ...row.away, score: null }, home: { ...row.home, score: null } },
        makeMatchup(),
      ]),
    );
    expect(seen).toContain('Ohio State at Iowa');
    expect(seen).toContain('Score temporarily unavailable');
    expect(seen).not.toContain('Score unavailable Score');
    expectClean(markup);
  });
});

describe('upcoming games', () => {
  it('show the kickoff time and the TV, under their day', () => {
    const row = makeMatchup();
    const { seen } = renderBoard(matchupBoardResponse([row]));
    expect(seen).toContain(`Ohio State at Iowa ${formatKickoffTime(row)}`);
    expect(seen).toContain('TV: FOX');
  });

  it('a TBD kickoff shows "Time TBD", never a placeholder time, and sits last in its day', () => {
    const tbd = makeMatchup({
      providerGameId: 'tbd',
      kickoffUtc: '2026-10-10T04:00:00.000Z',
      kickoffTbd: true,
    });
    const { seen, markup } = renderBoard(matchupBoardResponse([makeMatchup(), tbd]));
    expect(seen).toContain('Time TBD');
    expect(seen).not.toMatch(/12:00 AM|11:00 PM|9:00 PM/);
    expect(markup.indexOf('/matchups/401500001')).toBeLessThan(markup.indexOf('/matchups/tbd'));
  });

  it('a neutral site reads "vs", in the name and in words', () => {
    const { seen } = renderBoard(matchupBoardResponse([makeMatchup({ neutralSite: true })]));
    expect(seen).toContain('Ohio State vs Iowa');
    expect(seen).toContain('vs Iowa');
    expect(seen).toContain('Neutral site');
  });
});

describe('finals, postponements, and cancellations', () => {
  it('a final says Final only because the provider does, and marks the winner by shape', () => {
    const { seen, heard, markup } = renderBoard(matchupBoardResponse([finalMatchup()]));
    expect(seen).toContain('Final');
    // `spokenText` only strips a bare `aria-hidden` span, so the tile's letter
    // stays in; a screen reader hears "Won", from the hidden word beside it.
    expect(heard).toMatch(/Picked by Wilson W?Won score 31/);
    expect(heard).toMatch(/Picked by Steph L?Lost score 24/);
    expect(markup).toMatch(/class="[^"]*win[^"]*" aria-hidden="true">W</);
  });

  it('keeps the provider’s own "Final/OT"', () => {
    const { seen } = renderBoard(
      matchupBoardResponse([finalMatchup({ statusDetail: 'Final/OT' })]),
    );
    expect(seen).toContain('Final/OT');
  });

  it('a postponed game says Postponed, with no score and no TV', () => {
    const { seen } = renderBoard(
      matchupBoardResponse([makeMatchup({ status: 'postponed', statusDetail: 'Postponed' })]),
    );
    expect(seen).toContain('Postponed and canceled');
    expect(seen).toContain('Ohio State at Iowa Postponed');
    expect(seen).not.toContain('TV:');
  });
});

describe('who has each side', () => {
  it('a same-owner game says "Both Wilson’s" in words', () => {
    const row = makeMatchup({ sameOwner: true });
    const { seen } = renderBoard(
      matchupBoardResponse([{ ...row, home: { ...row.home, owners: [WILSON] } }]),
    );
    expect(seen).toContain("Both Wilson's");
  });

  it('a two-owner side lists both names, sorted, separated in seen and spoken text', () => {
    const row = makeMatchup();
    const { seen, heard } = renderBoard(
      matchupBoardResponse([{ ...row, away: { ...row.away, owners: [JORDAN, WILSON] } }]),
    );
    expect(seen).toContain('Jordan, Wilson');
    expect(heard).toContain('Picked by Jordan, Wilson');
  });

  it('the longest name and a two-owner side fit one card with no raw value', () => {
    const row = makeMatchup();
    const { markup, seen } = renderBoard(
      matchupBoardResponse([
        {
          ...row,
          away: {
            ...row.away,
            team: makeTeam({ name: LONGEST_NAME, displayName: LONGEST_NAME }),
            owners: [JORDAN, STEPH, WILSON],
          },
        },
      ]),
    );
    expect(seen).toContain(`${LONGEST_NAME} at Iowa`);
    expect(seen).toContain('Jordan, Steph, Wilson');
    expectClean(markup);
  });

  it('a missing rank is —, an unranked team NR, and a missing record —', () => {
    const row = makeMatchup();
    const { seen, heard } = renderBoard(
      matchupBoardResponse([
        { ...row, away: { ...row.away, ranking: { kind: 'unavailable' }, record: null } },
      ]),
    );
    expect(seen).toContain('Ohio State — — Wilson');
    expect(heard).toContain('Ranking unavailable Record unavailable');
    expect(seen).toContain('Iowa NR');
  });
});

describe('weeks with nothing to show', () => {
  it('an empty week says so in words', () => {
    const { seen, markup } = renderBoard(matchupBoardResponse([]));
    expect(seen).toContain('No games between boards this week');
    expect(headings(markup)[0]).toBe('h1:Week 6 matchups');
    expectClean(markup);
  });

  it('the offseason says so, under a heading that names no week', () => {
    const { seen, markup } = renderBoard(
      matchupBoardResponse([], {
        season: { year: 2026, type: 'preseason', week: null },
        week: null,
        weeks: [],
        notice: 'offseason',
      }),
      '/matchups',
    );
    expect(headings(markup)[0]).toBe('h1:Matchups');
    expect(seen).toContain('It’s the offseason');
    expect(seen).toContain('2026 preseason');
    expectClean(markup);
  });

  it('an unknown week says the calendar is unavailable, with its reference', () => {
    const { seen, markup } = renderBoard(
      matchupBoardResponse([], {
        week: null,
        weeks: [],
        notice: 'week_unknown',
        error: PROVIDER_DOWN,
        freshness: freshness('unavailable'),
      }),
      '/matchups',
    );
    expect(seen).toContain('This week couldn’t be worked out');
    expect(seen).toContain(`Reference: ${PROVIDER_DOWN.requestId ?? ''}`);
    expect(seen).toContain('Try again');
    expectClean(markup);
  });

  it('a week the provider could not answer keeps the page, says so, and gives the reference', () => {
    const { seen, markup } = renderBoard(
      matchupBoardResponse([], { error: PROVIDER_DOWN, freshness: freshness('unavailable') }),
    );
    expect(headings(markup)[0]).toBe('h1:Week 6 matchups');
    expect(seen).toContain('Matchups temporarily unavailable');
    expect(seen).toContain(`Reference: ${PROVIDER_DOWN.requestId ?? ''}`);
    expect(seen).not.toContain('No games between boards');
    expectClean(markup);
  });
});

describe('the request itself', () => {
  it('shows a skeleton, with a heading, on the first load only', () => {
    const { markup, seen } = renderBoard(undefined);
    expect(markup).toContain('role="status"');
    expect(spokenText(markup)).toContain('Loading matchups…');
    expect(seen).not.toMatch(RAW_VALUE);
    expect(markup.match(/<h1/g)).toHaveLength(1);
  });

  it('a failed request is an error with Try again and the reference', () => {
    const { seen, markup } = renderBoard(
      new ApiError(
        { kind: 'internal', message: 'Something went wrong on the server.', requestId: 'req-500' },
        500,
      ),
    );
    expect(seen).toContain('Unable to load the matchups');
    expect(seen).toContain('Try again');
    expect(seen).toContain('Reference: req-500');
    expect(markup).toContain('role="alert"');
    expectClean(markup);
  });

  it('a 429 says to wait, not that something broke', () => {
    const { seen } = renderBoard(
      new ApiError(
        { kind: 'rate_limited', message: 'Too many requests.', requestId: 'req-429' },
        429,
      ),
    );
    expect(seen).toContain('Too many requests');
    expect(seen).toContain('Wait a moment, then try again.');
    expect(seen).not.toContain('Unable to load');
  });

  it('a week the calendar does not have links back to this week', () => {
    const { seen, markup } = renderBoard(
      new ApiError(
        {
          kind: 'invalid_request',
          message: "There is no week 40 in this season's calendar.",
          requestId: 'req-400',
        },
        400,
      ),
      '/matchups?week=40',
    );
    expect(seen).toContain('No such week');
    expect(seen).toContain("There is no week 40 in this season's calendar.");
    expect(links(markup)).toContain('/matchups This week’s matchups');
  });
});

describe('the card’s way into the game', () => {
  it('carries this board, this week, as the game page’s way back', () => {
    // Router state is not in the markup; the link itself is what can be checked here.
    const rows: Matchup[] = [makeMatchup()];
    const { markup } = renderBoard(matchupBoardResponse(rows), '/matchups?week=6');
    expect(markup).toContain('href="/matchups/401500001"');
  });
});
