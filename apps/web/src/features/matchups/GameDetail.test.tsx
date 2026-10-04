import type { GameDetailResponse, MatchupResponse, PredictionResponse } from '@cfb/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../lib/api';
import { ApiError } from '../../lib/apiClient';
import {
  finalGameDetail,
  finalMatchup,
  gameDetailResponse,
  LIVE_SITUATION,
  liveGameDetail,
  liveMatchup,
  makeMatchup,
  makePrediction,
  matchupResponse,
  predictionResponse,
  PROVIDER_DOWN,
  upcomingGameDetail,
} from '../../test/fixtures';
import realSaturday from '../../test/real-saturday.json';
import { RAW_VALUE, renderAt, spokenText, visibleText } from '../../test/render';
import { MatchupPage } from './MatchupPage';

/**
 * Inside the game (plan-matchup-board, Phase 3): the line score, ESPN's live
 * win probability above the pregame predictor, stats or season averages,
 * leaders, the drive, and the scoring plays — and the header's situation line.
 * Every state of the detail read, each asserted in seen and spoken text.
 */

interface Reads {
  game: MatchupResponse;
  detail?: GameDetailResponse | ApiError | undefined;
  prediction?: PredictionResponse | undefined;
}

function seedError(client: QueryClient, queryKey: readonly unknown[], error: ApiError): void {
  client
    .getQueryCache()
    .build(client, { queryKey })
    .setState({ status: 'error', error, errorUpdatedAt: Date.now(), fetchStatus: 'idle' });
}

function render({ game, detail, prediction }: Reads) {
  const gameId = game.matchup.providerGameId;
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  client.setQueryData(queryKeys.matchup(gameId), game);
  if (detail instanceof ApiError) seedError(client, queryKeys.gameDetail(gameId), detail);
  else if (detail !== undefined) client.setQueryData(queryKeys.gameDetail(gameId), detail);
  if (prediction !== undefined) client.setQueryData(queryKeys.prediction(gameId), prediction);
  const markup = renderAt(`/matchups/${gameId}`, '/matchups/:gameId', <MatchupPage />, client);
  return { markup, seen: visibleText(markup), heard: spokenText(markup) };
}

function headings(markup: string): string[] {
  return [...markup.matchAll(/<(h[1-3])[^>]*>(.*?)<\/\1>/g)].map(
    ([, level, inner]) => `${level ?? ''}:${visibleText(inner ?? '')}`,
  );
}

/** No raw value, no invented zero score or percentage, one h1 — in seen AND spoken text. */
function expectClean(markup: string): void {
  for (const text of [visibleText(markup), spokenText(markup)]) {
    expect(text).not.toMatch(RAW_VALUE);
    expect(text).not.toMatch(/\bNaN\b|\bundefined\b|0–0|(?<![\d.])0%/);
  }
  expect(markup.match(/<h1/g)).toHaveLength(1);
}

const livePrediction = (gameId: string) =>
  predictionResponse(
    makePrediction({
      providerGameId: gameId,
      homeWinPct: 38.8,
      awayWinPct: 61.2,
      home: { providerTeamId: '2294', name: 'Iowa Hawkeyes', abbreviation: 'IOWA' },
      away: { providerTeamId: '194', name: 'Ohio State Buckeyes', abbreviation: 'OSU' },
    }),
  );

// ─── Live ────────────────────────────────────────────────────────────────────

describe('during the game', () => {
  const row = liveMatchup({ situation: LIVE_SITUATION });
  const { markup, seen, heard } = render({
    game: matchupResponse(row),
    detail: gameDetailResponse(liveGameDetail()),
    prediction: livePrediction(row.providerGameId),
  });

  it('lays the sections out in §51 order: now first', () => {
    expect(headings(markup)).toEqual([
      'h1:Ohio State at Iowa',
      'h2:Ohio State',
      'h2:@ Iowa',
      'h2:Score by quarter',
      'h2:Win probability',
      'h2:Who’s favored',
      'h2:Team stats',
      'h2:Leaders',
      'h3:Passing',
      'h3:Rushing',
      'h3:Receiving',
      'h2:Current drive',
      'h2:Scoring plays',
    ]);
  });

  it('says who has the ball, in words, and the down and distance', () => {
    expect(seen).toContain('OSU ball, 2nd & 7 at IOWA 34');
    expect(seen).toContain('Ohio State #2 5-0 Has the ball');
    expect(seen).toContain('Last play: (4:40) C. Kurtz pass complete');
  });

  it('makes only the score and the situation line live regions', () => {
    expect(markup.match(/aria-live="polite"/g)).toHaveLength(2);
    const situation = /<p class="[^"]*situation[^"]*" aria-live="polite"[^>]*>(.*?)<\/p>/.exec(
      markup,
    );
    expect(situation?.[1]).toBe('OSU ball, 2nd &amp; 7 at IOWA 34');
  });

  it('a line score table: caption, headers, quarters played, a total', () => {
    expect(markup).toContain(
      '<caption class="visually-hidden">Score by quarter, then the total</caption>',
    );
    expect(markup).toMatch(
      /<th scope="row">OSU<\/th><td>7<\/td><td>7<\/td><td class="[^"]*">14<\/td>/,
    );
    expect(markup).toMatch(
      /<th scope="row">IOWA<\/th><td>7<\/td><td>0<\/td><td class="[^"]*">7<\/td>/,
    );
    expect(heard).toContain('2nd quarter');
    expect(seen).not.toContain('OT');
  });

  it('labels the two ESPN models apart: live win probability, then the pregame predictor', () => {
    expect(seen).toContain('OSU 78.6% IOWA 21.4%');
    expect(seen).toContain('Source: ESPN win probability (live)');
    expect(seen).toContain(
      'Pregame prediction, made before kickoff. It does not change during the game.',
    );
    expect(seen).toContain('Source: ESPN matchup predictor');
    expect(seen.indexOf('ESPN win probability (live)')).toBeLessThan(
      seen.indexOf('ESPN matchup predictor'),
    );
    expect(heard).toContain('OSU 78.6% chance to win');
  });

  it('draws the trend as decoration, with its numbers in words', () => {
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(seen).toContain('IOWA: 38% after the first play, 21.4% now');
    expect(seen).toContain('can trail the score by a play');
  });

  it('prints the provider’s stat strings verbatim, and a dash for a missing one', () => {
    expect(markup).toMatch(/<th scope="row">3rd down efficiency<\/th><td>4-7<\/td><td>2-6<\/td>/);
    expect(markup).toMatch(/<th scope="row">4th down efficiency<\/th><td>—<\/td><td>0-0<\/td>/);
    expect(seen).not.toContain('Season averages');
  });

  it('leaders per side, with a dash and words for a side with none', () => {
    expect(seen).toContain('OSU Julian Sayin, 12/16, 151 YDS, 2 TD');
    expect(seen).toContain('OSU —');
    expect(heard).toContain('OSU — none listed');
  });

  it('the drive, and the scoring plays newest first', () => {
    expect(seen).toContain('OSU ball: 6 plays, 41 yards, 2:51');
    expect(seen).toContain('Newest first');
    expect(seen.indexOf('Carnell Tate')).toBeLessThan(seen.indexOf('Jeremiah Smith 22 Yd'));
    expect(seen).toContain('Q2 6:30 OSU TD OSU 14, IOWA 7');
    expect(heard).toContain('2nd quarter, 6:30 OSU TD');
  });

  it('dates each part by its own read: the score’s time, and the stats’ time', () => {
    expect(seen).toContain('Score updated');
    expect(markup).toContain('dateTime="2026-10-10T21:40:30.000Z"');
  });

  it('calls nothing Final, and never renders a raw value', () => {
    expect(seen).not.toContain('Final');
    expectClean(markup);
  });

  it('a row the slate could not check shows no situation line at all', () => {
    const { markup: unchecked, seen: words } = render({
      game: matchupResponse(liveMatchup()),
      detail: gameDetailResponse(liveGameDetail()),
    });
    expect(words).not.toContain('ball,');
    expect(words).not.toContain('Has the ball');
    expectClean(unchecked);
  });

  it('a stale detail says so with its original time, and keeps its numbers', () => {
    const { seen: stale } = render({
      game: matchupResponse(liveMatchup()),
      detail: gameDetailResponse(liveGameDetail(), 'stale', null, '2026-10-10T21:30:00.000Z'),
    });
    expect(stale).toContain('May be out of date');
    expect(stale).toContain('Team stats');
  });

  it('halftime: the provider’s wording, no clock invented', () => {
    const { seen: half, markup: halfMarkup } = render({
      game: matchupResponse(
        liveMatchup({ statusDetail: 'Halftime', clock: '0:00', period: 2, situation: null }),
      ),
      detail: gameDetailResponse(liveGameDetail({ currentDrive: null })),
    });
    expect(half).toContain('Halftime');
    expect(half).not.toContain('Current drive');
    expectClean(halfMarkup);
  });
});

// ─── Before kickoff ──────────────────────────────────────────────────────────

describe('before kickoff', () => {
  const row = makeMatchup();
  const { markup, seen } = render({
    game: matchupResponse(row),
    detail: gameDetailResponse(upcomingGameDetail()),
    prediction: livePrediction(row.providerGameId),
  });

  it('season averages are labelled as such, twice, and never called team stats', () => {
    expect(headings(markup)).toContain('h2:Season averages');
    expect(headings(markup)).toContain('h2:Season leaders');
    expect(seen).toContain('Not this game’s numbers.');
    expect(seen).not.toContain('Team stats');
    expect(markup).toMatch(/<th scope="row">Points Per Game<\/th><td>41.6<\/td><td>24.2<\/td>/);
  });

  it('the pregame predictor, and nothing from a game not yet played', () => {
    expect(seen).toContain('Source: ESPN matchup predictor');
    expect(seen).not.toContain('Pregame prediction, made before kickoff');
    expect(seen).not.toContain('Win probability');
    expect(seen).not.toContain('Score by quarter');
    expect(seen).not.toContain('Scoring plays');
    expect(seen).not.toContain('Current drive');
    expectClean(markup);
  });
});

// ─── Final ───────────────────────────────────────────────────────────────────

describe('a final game', () => {
  const { markup, seen } = render({
    game: matchupResponse(finalMatchup()),
    detail: gameDetailResponse(finalGameDetail()),
  });

  it('stats and scoring plays in game order; no win probability of either kind', () => {
    expect(seen).toContain('Team stats');
    expect(seen).toContain('Scoring plays');
    expect(seen).not.toContain('Newest first');
    expect(seen.indexOf('Jeremiah Smith 22 Yd')).toBeLessThan(seen.indexOf('Carnell Tate'));
    expect(seen).not.toContain('Win probability');
    expect(seen).not.toContain('Who’s favored');
    expect(seen).not.toContain('ESPN matchup predictor');
    expect(seen).not.toContain('ESPN win probability');
  });

  it('a line score with all four quarters and the provider’s totals', () => {
    expect(markup).toMatch(/<th scope="row">OSU<\/th>(<td>\d+<\/td>){4}<td class="[^"]*">31<\/td>/);
    expect(seen).not.toContain('Has the ball');
    expectClean(markup);
  });

  it('a live probability is never shown beside a Final header, even if the detail lags', () => {
    const { seen: lagging } = render({
      game: matchupResponse(finalMatchup()),
      detail: gameDetailResponse(liveGameDetail()),
    });
    expect(lagging).not.toContain('Win probability');
    expect(lagging).not.toContain('Current drive');
  });
});

// ─── Failure and emptiness ───────────────────────────────────────────────────

describe('the detail failing leaves the header and the prediction (§42)', () => {
  it('a failed request: "Stats unavailable", the reference, and Try again', () => {
    const row = liveMatchup();
    const { markup, seen } = render({
      game: matchupResponse(row),
      detail: new ApiError({ ...PROVIDER_DOWN, requestId: 'req-77' }, 503),
      prediction: livePrediction(row.providerGameId),
    });
    expect(seen).toContain('Ohio State at Iowa');
    expect(seen).toContain('Source: ESPN matchup predictor');
    expect(seen).toContain('Stats unavailable');
    expect(seen).toContain('Reference: req-77');
    expect(markup).toMatch(/<button[^>]*>Try again<\/button>/);
    expectClean(markup);
  });

  it('an answer that says "unavailable" quotes the reference it was logged under', () => {
    const { seen } = render({
      game: matchupResponse(liveMatchup()),
      detail: gameDetailResponse(null, 'unavailable', {
        ...PROVIDER_DOWN,
        requestId: 'req-logged',
      }),
    });
    expect(seen).toContain('Stats unavailable');
    expect(seen).toContain('Reference: req-logged');
    expect(seen).toContain('Try again');
  });

  it('a 429 says to wait', () => {
    const { seen } = render({
      game: matchupResponse(makeMatchup()),
      detail: new ApiError(
        { kind: 'rate_limited', message: 'Too many requests.', requestId: 'req-9' },
        429,
      ),
    });
    expect(seen).toContain('Wait a moment, then try again.');
  });

  it('still loading: a labelled placeholder, once', () => {
    const { markup, heard } = render({ game: matchupResponse(makeMatchup()) });
    expect(heard).toContain('Loading game details…');
    expectClean(markup);
  });

  it('a postponed game with nothing published says so in words', () => {
    const { markup, seen } = render({
      game: matchupResponse(makeMatchup({ status: 'postponed', statusDetail: 'Postponed' })),
      detail: gameDetailResponse(
        upcomingGameDetail({ status: 'postponed', teamStats: [], leaders: [] }),
      ),
    });
    expect(seen).toContain('No team stats have been published for this game.');
    expect(seen).not.toContain('Season leaders');
    expectClean(markup);
  });

  it('a live game with no score yet: "Score unavailable", and no points invented', () => {
    const row = liveMatchup();
    const { markup, seen } = render({
      game: matchupResponse({
        ...row,
        away: { ...row.away, score: null },
        home: { ...row.home, score: null },
      }),
      detail: gameDetailResponse(
        liveGameDetail({
          lineScore: {
            periods: [{ number: 1, label: '1', home: null, away: null }],
            homeTotal: null,
            awayTotal: null,
          },
          scoringPlays: [],
        }),
      ),
    });
    expect(seen).toContain('Score unavailable');
    expect(seen).toContain('No points scored yet.');
    expect(markup).toMatch(/<th scope="row">OSU<\/th><td>—<\/td><td class="[^"]*">—<\/td>/);
    expectClean(markup);
  });
});

// ─── The real Saturday ───────────────────────────────────────────────────────

/**
 * The three answers the API gave for the captured California at UNLV game
 * (4th quarter, 2026-10-03), generated by apps/api/test/detail.test.ts from
 * the real ESPN payloads. The plan's real-payload criterion: the three labels,
 * asserted where they are rendered.
 */
describe('the captured live Saturday, rendered', () => {
  const saved = realSaturday as unknown as {
    matchup: MatchupResponse;
    detail: GameDetailResponse;
    prediction: PredictionResponse;
  };
  const { markup, seen } = render({
    game: saved.matchup,
    detail: saved.detail,
    prediction: saved.prediction,
  });

  it('asserts the three labels where they are seen', () => {
    // ESPN's own capitalisation, verbatim: the panel prints the provider's label.
    expect(seen).toContain('Source: ESPN Matchup Predictor');
    expect(seen).toContain('Source: ESPN win probability (live)');
    expect(seen).toContain(
      'Pregame prediction, made before kickoff. It does not change during the game.',
    );
  });

  it('the situation, the line score, and the stats, from ESPN’s strings', () => {
    expect(seen).toContain('LIVE 7:39 - 4th Quarter UNLV ball, 1st & 10 at UNLV 48');
    expect(seen).toContain('Team stats');
    expect(seen).toContain('3rd down efficiency');
    expect(markup).toMatch(
      /<th scope="row">UNLV<\/th><td>7<\/td><td>17<\/td><td>0<\/td><td>8<\/td><td class="[^"]*">32<\/td>/,
    );
    expect(seen).not.toContain('Final');
    expectClean(markup);
  });
});
