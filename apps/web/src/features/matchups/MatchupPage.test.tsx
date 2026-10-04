import type { Matchup, MatchupResponse, PredictionResponse } from '@cfb/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../lib/api';
import { ApiError } from '../../lib/apiClient';
import {
  finalMatchup,
  freshness,
  JORDAN,
  liveMatchup,
  makeMatchup,
  makePrediction,
  matchupBoardResponse,
  matchupResponse,
  predictionResponse,
  PROVIDER_DOWN,
  WILSON,
} from '../../test/fixtures';
import { RAW_VALUE, renderAt, spokenText, visibleText } from '../../test/render';
import { MatchupPage } from './MatchupPage';

/**
 * The first game page (plan-matchup-board, Phase 2): both teams and their
 * owners, where the game stands, and the pregame win probability through the
 * team page's own `PredictionPanel`, ordered away then home.
 */

/** Ohio State (away, 61.2%) at Iowa (home, 38.8%), for the default game. */
function prediction(providerGameId = '401500001') {
  return makePrediction({
    providerGameId,
    homeWinPct: 38.8,
    awayWinPct: 61.2,
    home: { providerTeamId: '2294', name: 'Iowa Hawkeyes', abbreviation: 'IOWA' },
    away: { providerTeamId: '194', name: 'Ohio State Buckeyes', abbreviation: 'OSU' },
  });
}

interface Reads {
  game?: MatchupResponse | ApiError | undefined;
  prediction?: PredictionResponse | ApiError | undefined;
  /** A matchup board already in the cache, as when the page is opened from a card. */
  board?: Matchup[];
  state?: unknown;
}

function seedError(client: QueryClient, queryKey: readonly unknown[], error: ApiError): void {
  client
    .getQueryCache()
    .build(client, { queryKey })
    .setState({ status: 'error', error, errorUpdatedAt: Date.now(), fetchStatus: 'idle' });
}

function renderGame(reads: Reads, gameId = '401500001') {
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const { game, prediction: predicted, board, state } = reads;
  if (game instanceof ApiError) seedError(client, queryKeys.matchup(gameId), game);
  else if (game !== undefined) client.setQueryData(queryKeys.matchup(gameId), game);
  if (predicted instanceof ApiError) seedError(client, queryKeys.prediction(gameId), predicted);
  else if (predicted !== undefined) client.setQueryData(queryKeys.prediction(gameId), predicted);
  if (board !== undefined) {
    client.setQueryData(queryKeys.matchupBoard('6'), matchupBoardResponse(board));
  }
  const markup = renderAt(
    `/matchups/${gameId}`,
    '/matchups/:gameId',
    <MatchupPage />,
    client,
    state,
  );
  return { markup, seen: visibleText(markup), heard: spokenText(markup) };
}

function headings(markup: string): string[] {
  return [...markup.matchAll(/<(h[1-3])[^>]*>(.*?)<\/\1>/g)].map(
    ([, level, inner]) => `${level ?? ''}:${visibleText(inner ?? '')}`,
  );
}

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

describe('before kickoff: the header and who ESPN favours', () => {
  const { markup, seen, heard } = renderGame({
    game: matchupResponse(makeMatchup()),
    prediction: predictionResponse(prediction()),
  });

  it('has one h1, "Ohio State at Iowa", then each team, then the prediction', () => {
    expect(headings(markup)).toEqual([
      'h1:Ohio State at Iowa',
      'h2:Ohio State',
      'h2:@ Iowa',
      'h2:Who’s favored',
      // The detail is its own request, still loading here (Phase 3).
      'h2:Game details',
    ]);
  });

  it('links each team to its page and each owner to their board', () => {
    const all = links(markup);
    expect(all.filter((link) => link.startsWith('/teams/'))).toHaveLength(2);
    expect(all).toContain(`/u/${WILSON.userId} Wilson`);
    expect(markup).toContain('aria-label="Wilson&#x27;s board"');
  });

  it('gives the rank, record, kickoff, venue, and TV', () => {
    expect(seen).toContain('Ohio State #2 5-0 Picked by Wilson');
    expect(seen).toContain('@ Iowa NR 3-2 Picked by Steph');
    expect(seen).toContain('Kinnick Stadium');
    expect(seen).toContain('TV: FOX');
    expect(markup).toContain('dateTime="2026-10-10T19:30:00.000Z"');
  });

  it('lists away first, then home, neither marked as the page’s own, with ESPN named', () => {
    expect(seen).toContain('Ohio State 61.2% Iowa 38.8%');
    expect(seen).toContain('Source: ESPN matchup predictor');
    expect(markup).not.toMatch(/class="[^"]*ours/);
    expect(heard).toContain('Ohio State 61.2% chance to win');
  });

  it('says nothing about the game being under way', () => {
    expect(seen).not.toContain('Pregame prediction');
    expect(seen).not.toContain('LIVE');
  });

  it('goes back to this game’s week, not to the current one', () => {
    expect(links(markup)[0]).toBe('/matchups?week=6 Week 6 matchups');
  });

  it('never renders a raw value', () => {
    expectClean(markup);
  });
});

describe('during the game', () => {
  const { markup, seen } = renderGame(
    {
      game: matchupResponse(liveMatchup()),
      prediction: predictionResponse(prediction('401500002')),
    },
    '401500002',
  );

  it('leads with LIVE, the situation, and the score, dated by its own read', () => {
    expect(seen).toContain('Ohio State at Iowa LIVE 4:32 - 2nd Quarter');
    expect(seen).toMatch(/Picked by Wilson 14/);
    expect(seen).toMatch(/Picked by Steph 7/);
    expect(seen).toContain('Score updated');
    expect(markup).toContain('dateTime="2026-10-10T21:41:00.000Z"');
  });

  it('labels the prediction as pregame, made before kickoff', () => {
    expect(seen).toContain(
      'Pregame prediction, made before kickoff. It does not change during the game.',
    );
    expect(seen).toContain('In progress');
  });

  it('makes the scores and the situation line the only polite live regions (Phase 3)', () => {
    expect(markup.match(/aria-live="polite"/g)).toHaveLength(2);
    expect(markup).toMatch(/<p class="[^"]*situation[^"]*" aria-live="polite"/);
  });

  it('calls nothing Final', () => {
    expect(seen).not.toContain('Final');
  });

  it('says "score unavailable" rather than 0–0 when the provider sent none', () => {
    const row = liveMatchup();
    const { seen: noScore } = renderGame(
      {
        game: matchupResponse({
          ...row,
          away: { ...row.away, score: null },
          home: { ...row.home, score: null },
        }),
      },
      '401500002',
    );
    expect(noScore).toContain('Score unavailable');
    expect(noScore).not.toMatch(/0–0/);
  });

  it('says a stale score may be out of date, with its original time (§39)', () => {
    const { seen: stale, markup: staleMarkup } = renderGame(
      {
        game: matchupResponse(
          liveMatchup({ freshness: freshness('stale', '2026-10-10T21:30:00.000Z') }),
        ),
      },
      '401500002',
    );
    expect(stale).toContain('May be out of date. Last updated:');
    expect(stale).not.toContain('Score updated');
    expect(staleMarkup).toContain('dateTime="2026-10-10T21:30:00.000Z"');
  });
});

describe('after the game', () => {
  it('shows the result and no prediction of any kind', () => {
    const { seen, markup } = renderGame(
      {
        game: matchupResponse(finalMatchup()),
        prediction: predictionResponse(prediction('401500003')),
      },
      '401500003',
    );
    expect(seen).toContain('Final');
    expect(seen).toMatch(/W 31/);
    expect(seen).not.toContain('Who’s favored');
    expect(seen).not.toContain('%');
    expect(seen).not.toContain('Prediction unavailable');
    expectClean(markup);
  });

  it('shows no prediction for a canceled game either', () => {
    const { seen } = renderGame({
      game: matchupResponse(makeMatchup({ status: 'canceled', statusDetail: 'Canceled' })),
    });
    expect(seen).toContain('Canceled');
    expect(seen).not.toContain('Who’s favored');
  });
});

describe('without a prediction', () => {
  it('says "Prediction unavailable", and why, when ESPN has none', () => {
    const { seen } = renderGame({
      game: matchupResponse(makeMatchup()),
      prediction: predictionResponse(null),
    });
    expect(seen).toContain('Who’s favored');
    expect(seen).toContain(
      'Prediction unavailable No prediction has been published for this game.',
    );
  });

  it('keeps the header when the prediction request failed', () => {
    const { seen } = renderGame({
      game: matchupResponse(makeMatchup()),
      prediction: new ApiError(PROVIDER_DOWN, 503),
    });
    expect(seen).toContain('Ohio State at Iowa');
    expect(seen).toContain('Prediction unavailable');
    expect(seen).toContain('Reference: req-123');
  });

  it('says it is loading while the prediction is on its way', () => {
    const { heard } = renderGame({ game: matchupResponse(makeMatchup()) });
    expect(heard).toContain('Loading prediction…');
  });
});

describe('who has each side', () => {
  it('says "Both Wilson’s" when one person has both', () => {
    const row = makeMatchup({ sameOwner: true });
    const { seen } = renderGame({
      game: matchupResponse({ ...row, home: { ...row.home, owners: [WILSON] } }),
    });
    expect(seen).toContain("Both Wilson's");
  });

  it('links every owner of a two-owner side, sorted', () => {
    const row = makeMatchup();
    const { markup, seen } = renderGame({
      game: matchupResponse({ ...row, away: { ...row.away, owners: [JORDAN, WILSON] } }),
    });
    expect(seen).toContain('Picked by Jordan Wilson');
    expect(links(markup)).toEqual(
      expect.arrayContaining([`/u/${JORDAN.userId} Jordan`, `/u/${WILSON.userId} Wilson`]),
    );
  });

  it('says a side is on no board, and links it by the provider’s id', () => {
    const row = makeMatchup();
    const { markup, seen } = renderGame({
      game: matchupResponse({
        ...row,
        home: { ...row.home, owners: [], team: { ...row.home.team, id: null } },
      }),
    });
    expect(seen).toContain('Not on any board');
    expect(links(markup)).toContain('/teams/2294 Iowa');
  });
});

describe('the way in and the way back', () => {
  it('paints at once from a loaded board, before its own request answers', () => {
    const { seen } = renderGame({ board: [makeMatchup()] });
    expect(seen).toContain('Ohio State at Iowa');
    expect(seen).not.toContain('Loading game');
  });

  it('goes back the way it came when opened from a board', () => {
    const { markup } = renderGame({
      game: matchupResponse(makeMatchup()),
      state: { from: { path: '/matchups?week=6', label: 'Week 6 matchups' } },
    });
    expect(links(markup)[0]).toBe('/matchups?week=6 Week 6 matchups');
  });

  it('names a postseason week by its phase, never by its number', () => {
    const { markup } = renderGame({
      game: matchupResponse(
        makeMatchup({ season: { year: 2026, type: 'postseason', week: 999 }, week: 999 }),
      ),
    });
    expect(links(markup)[0]).toBe('/matchups?week=999 Postseason matchups');
  });
});

describe('the request itself', () => {
  it('shows a loading state with a heading while the game is on its way', () => {
    const { markup, heard } = renderGame({});
    expect(heard).toContain('Loading game…');
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(links(markup)[0]).toBe('/matchups All matchups');
  });

  it('explains a missing game, with a way to this week’s matchups', () => {
    const { seen, markup } = renderGame({
      game: new ApiError({ kind: 'not_found', message: 'No such game.', requestId: 'r' }, 404),
    });
    expect(seen).toContain('Game not found');
    expect(links(markup)).toContain('/matchups This week’s matchups');
    expect(seen).not.toContain('Reference');
  });

  it('a failed request offers Try again and the reference', () => {
    const { seen } = renderGame({ game: new ApiError(PROVIDER_DOWN, 503) });
    expect(seen).toContain('Unable to load this game');
    expect(seen).toContain('Try again');
    expect(seen).toContain('Reference: req-123');
  });

  it('a 429 says to wait', () => {
    const { seen } = renderGame({
      game: new ApiError({ kind: 'rate_limited', message: 'Slow down.', requestId: 'r' }, 429),
    });
    expect(seen).toContain('Too many requests Wait a moment, then try again.');
  });
});
