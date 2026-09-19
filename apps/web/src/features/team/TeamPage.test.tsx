import type {
  PredictionResponse,
  TeamDetailResponse,
  TeamScheduleResponse,
  TeamSnapshot,
} from '@cfb/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../lib/api';
import { ApiError } from '../../lib/apiClient';
import {
  envelope,
  finalGame,
  liveGame,
  makeGame,
  makePrediction,
  makeSnapshot,
  makeTeam,
  predictionResponse,
  PROVIDER_DOWN,
  scheduleResponse,
  seasonItems,
  teamDetail,
} from '../../test/fixtures';
import { RAW_VALUE, renderAt, spokenText, visibleText } from '../../test/render';
import { TeamPage } from './TeamPage';

/**
 * Phase 4's exit criteria for the team page (§16), one `describe` each. The
 * page is three independent reads: the team (hero and game panels), the
 * schedule, and the prediction. Each test seeds the query cache with exactly
 * what the API would have returned, or with the failure it would have raised.
 */

const team = makeTeam({ providerTeamId: '333' });
const NEXT_GAME = '401000001';

/** `undefined` means that read has not answered yet: it is still loading. */
interface Reads {
  detail?: TeamDetailResponse | ApiError | undefined;
  schedule?: TeamScheduleResponse | ApiError | undefined;
  /** Keyed by the game the page will ask about. */
  prediction?: [string, PredictionResponse | ApiError] | undefined;
}

function seedError(client: QueryClient, queryKey: readonly unknown[], error: ApiError): void {
  client
    .getQueryCache()
    .build(client, { queryKey })
    .setState({ status: 'error', error, errorUpdatedAt: Date.now(), fetchStatus: 'idle' });
}

function renderTeam(reads: Reads) {
  // `retryOnMount: false` holds a seeded error in place.
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const { detail } = reads;
  if (detail instanceof ApiError) seedError(client, queryKeys.team(team.id), detail);
  else if (detail !== undefined) client.setQueryData(queryKeys.team(team.id), detail);

  const { schedule, prediction } = reads;
  if (schedule instanceof ApiError) seedError(client, queryKeys.schedule(team.id), schedule);
  else if (schedule !== undefined) client.setQueryData(queryKeys.schedule(team.id), schedule);

  if (prediction !== undefined) {
    const [gameId, response] = prediction;
    if (response instanceof ApiError) seedError(client, queryKeys.prediction(gameId), response);
    else client.setQueryData(queryKeys.prediction(gameId), response);
  }

  const markup = renderAt(`/teams/${team.id}`, '/teams/:teamId', <TeamPage />, client);
  return { markup, seen: visibleText(markup), heard: spokenText(markup) };
}

function detailWith(overrides: Partial<TeamSnapshot> = {}): TeamDetailResponse {
  return teamDetail(team, envelope(makeSnapshot(team, overrides)));
}

/** Every read answered: the ordinary mid-season page. */
function fullPage(overrides: Partial<Reads> = {}) {
  return renderTeam({
    detail: detailWith(),
    schedule: scheduleResponse(team),
    prediction: [NEXT_GAME, predictionResponse(makePrediction())],
    ...overrides,
  });
}

function headings(markup: string): string[] {
  return [...markup.matchAll(/<(h[1-3])[^>]*>(.*?)<\/\1>/g)].map(
    ([, level, inner]) => `${level ?? ''}:${visibleText(inner ?? '')}`,
  );
}

function expectHeroAndPanels(seen: string): void {
  expect(seen).toContain('Alabama Crimson Tide, SEC');
  expect(seen).toContain('#4');
  expect(seen).toContain('4-0');
  expect(seen).toContain('Previous game vs LSU W 31–24');
  expect(seen).toContain('Next game @ Tennessee');
}

describe('exit 1 — identity, rank, record, conference, previous, next, prediction, schedule', () => {
  const { markup, seen, heard } = fullPage();

  it('shows every section, in the §16 order, under one h1', () => {
    expect(headings(markup)).toEqual([
      'h1:Alabama',
      'h2:Previous game',
      'h2:Next game',
      'h2:Matchup prediction',
      'h2:2026 schedule',
    ]);
  });

  it('leads with identity, rank, record, and conference, and names the poll (§7)', () => {
    expectHeroAndPanels(seen);
    expect(seen).toContain('Rankings: AP Top 25');
    expect(markup).toContain('alt="Alabama logo"');
  });

  it('shows the prediction from the team’s side, with its source named (§12, §46)', () => {
    expect(seen).toContain('Matchup prediction @ Tennessee');
    expect(seen).toContain('Alabama 67% Tennessee 33%');
    expect(heard).toContain('Alabama 67% chance to win');
    expect(seen).toContain('Source: ESPN matchup predictor');
    expect(seen).not.toContain('Pregame');
  });

  it('shows the complete schedule, byes, statuses, and results (§17)', () => {
    expect(seen).toContain('7 games');
    expect(markup).toContain('<table');
    expect(markup.match(/<th scope="row"/g)).toHaveLength(7);
    for (const text of ['Bye week', 'Final/OT', 'Canceled', 'Postponed', 'TBD', 'W 34–17']) {
      expect(seen).toContain(text);
    }
  });

  it('never renders a raw value or a placeholder time (§37)', () => {
    expect(seen).not.toMatch(RAW_VALUE);
    expect(heard).not.toMatch(RAW_VALUE);
    expect(seen).not.toContain('12:00 AM');
  });
});

describe('exit 2 — no prediction: the page renders fully with "Prediction unavailable"', () => {
  it('when the provider has none for this game (§12)', () => {
    const { seen } = fullPage({ prediction: [NEXT_GAME, predictionResponse(null)] });
    expect(seen).toContain('Prediction unavailable');
    expect(seen).toContain('No prediction has been published for this game.');
    expect(seen).not.toMatch(/\d+(\.\d)?%/);
    expectHeroAndPanels(seen);
    expect(seen).toContain('2026 schedule');
    expect(seen).not.toMatch(RAW_VALUE);
  });

  it('when the prediction request failed at the provider', () => {
    const { seen } = fullPage({
      prediction: [NEXT_GAME, predictionResponse(null, 'unavailable', PROVIDER_DOWN)],
    });
    expect(seen).toContain('Prediction unavailable');
    expect(seen).toContain('Sports data temporarily unavailable.');
    expect(seen).toContain('Reference: req-123');
    expectHeroAndPanels(seen);
  });

  it('when the request itself failed', () => {
    const { seen } = fullPage({
      prediction: [
        NEXT_GAME,
        new ApiError({ kind: 'internal', message: 'Server error.', requestId: 'r9' }, 500),
      ],
    });
    expect(seen).toContain('Prediction unavailable');
    expect(seen).toContain('Reference: r9');
    expectHeroAndPanels(seen);
  });

  it('when its numbers are not percentages: refused, never repaired', () => {
    const { seen } = fullPage({
      prediction: [
        NEXT_GAME,
        predictionResponse(makePrediction({ homeWinPct: Number.NaN, awayWinPct: 140 })),
      ],
    });
    expect(seen).toContain('Prediction unavailable');
    expect(seen).not.toContain('140%');
  });

  it('says it is loading while the prediction is on its way', () => {
    const { heard } = fullPage({ prediction: undefined });
    expect(heard).toContain('Loading prediction…');
  });
});

describe('exit 3 — schedule forced to fail: hero and game panels still render (§42)', () => {
  it('when the schedule request failed', () => {
    const { seen } = fullPage({
      schedule: new ApiError(
        { kind: 'internal', message: 'Something went wrong on the server.', requestId: 'r7' },
        500,
      ),
    });
    expect(seen).toContain('Schedule unavailable');
    expect(seen).toContain('Try again');
    expect(seen).toContain('Reference: r7');
    expectHeroAndPanels(seen);
    expect(seen).toContain('Alabama 67%');
    expect(seen).not.toMatch(RAW_VALUE);
  });

  it('when the provider failed behind the schedule', () => {
    const { markup, seen } = fullPage({
      schedule: scheduleResponse(team, [], 'unavailable', PROVIDER_DOWN),
    });
    expect(seen).toContain('Schedule unavailable');
    expect(seen).toContain('Sports data temporarily unavailable.');
    expect(markup).not.toContain('<table');
    expectHeroAndPanels(seen);
  });

  it('shows a stale schedule, labeled as such, rather than hiding it (§39)', () => {
    const { seen } = fullPage({ schedule: scheduleResponse(team, seasonItems(), 'stale') });
    expect(seen).toContain('May be out of date. Last updated:');
    expect(seen).toContain('W 34–17');
  });

  it('says so plainly when the schedule is empty', () => {
    const { seen } = fullPage({ schedule: scheduleResponse(team, []) });
    expect(seen).toContain('No games scheduled');
    expect(seen).not.toContain('0 games');
  });

  it('shows the schedule loading on its own while the rest of the page is ready', () => {
    const { seen, heard } = fullPage({ schedule: undefined });
    expect(heard).toContain('Loading schedule…');
    expectHeroAndPanels(seen);
  });

  it('keeps the schedule when it is the team snapshot that failed', () => {
    const { seen } = renderTeam({
      detail: teamDetail(team, envelope(null, 'unavailable', PROVIDER_DOWN)),
      schedule: scheduleResponse(team),
    });
    expect(seen).toContain('Sports data temporarily unavailable.');
    expect(seen).toContain('W 34–17');
    expect(seen).not.toContain('Matchup prediction');
  });
});

describe('exit 4 — a live game: the live block, with period and clock, and no "Final"', () => {
  const live = liveGame(); // 3rd quarter, 4:32, Alabama 24–21
  const updatedAt = '2026-10-01T17:59:45.000Z';
  const { markup, seen, heard } = renderTeam({
    detail: detailWith({ liveGame: live, liveUpdatedAt: updatedAt }),
    schedule: scheduleResponse(team, [
      { kind: 'game', game: live },
      { kind: 'game', game: makeGame({ providerGameId: 'after', week: 6 }) },
    ]),
    prediction: [
      live.providerGameId,
      predictionResponse(makePrediction({ providerGameId: live.providerGameId })),
    ],
  });
  const liveBlock = visibleText(markup.match(/<section[^>]*live game.*?<\/section>/)?.[0] ?? '');

  it('leads the page with LIVE, the score, the period, and the clock (§11)', () => {
    expect(liveBlock).toContain('LIVE');
    expect(liveBlock).toContain('4:32 - 3rd Quarter');
    expect(liveBlock).toMatch(/ALA ?24/);
    expect(liveBlock).toMatch(/Tennessee ?21/);
    expect(seen.indexOf('LIVE')).toBeLessThan(seen.indexOf('Previous game'));
  });

  it('dates the score by its own read, not by the card’s oldest part', () => {
    expect(liveBlock).toContain('Updated');
    expect(markup).toContain(`dateTime="${updatedAt}"`);
  });

  it('announces only the score as it changes (§48)', () => {
    expect(markup.match(/aria-live="polite"/g)).toHaveLength(1);
  });

  it('calls nothing on the page Final while the game is in progress', () => {
    expect(seen).not.toMatch(/final/i);
    expect(heard).not.toMatch(/final/i);
  });

  it('shows the prediction for the game in progress as a pregame prediction', () => {
    expect(seen).toContain('Matchup prediction @ Tennessee In progress');
    expect(seen).toContain('Pregame prediction, made before kickoff.');
    expect(seen).toContain('Alabama 67%');
  });

  it('marks the live row in the schedule with its score and no verdict', () => {
    const row = markup.match(/<tr[^>]*>(?:(?!<\/tr>).)*LIVE.*?<\/tr>/)?.[0] ?? '';
    expect(visibleText(row)).toContain('24–21');
    expect(visibleText(row)).not.toMatch(/\b[WLT] \d/);
  });
});

describe('exit 5 — the offseason: no upcoming games, nothing breaks, "Season complete" (§22)', () => {
  const lastGame = finalGame({ providerGameId: 'g12', week: 12 });
  const { markup, seen, heard } = renderTeam({
    detail: teamDetail(
      team,
      envelope(
        makeSnapshot(team, {
          record: { wins: 10, losses: 2, ties: null, summary: '10-2', conference: null },
          previousGame: lastGame,
          nextGame: { kind: 'none', reason: 'season_complete' },
        }),
      ),
      { year: 2026, type: 'postseason', week: null },
    ),
    schedule: scheduleResponse(
      team,
      seasonItems()
        .filter((item) => item.kind === 'bye' || item.game.status === 'final')
        .concat([{ kind: 'game', game: lastGame }]),
    ),
  });

  it('says the season is complete, and keeps the record and final schedule (§22)', () => {
    expect(seen).toContain('Season complete');
    expect(seen).toContain('10-2');
    expect(seen).toContain('2026 postseason');
    expect(seen).toContain('W 34–17');
    expect(seen).toContain('Bye week');
  });

  it('asks for no prediction, and says why there is none', () => {
    expect(seen).toContain('Prediction unavailable');
    expect(seen).toContain("There's no upcoming game to predict.");
    expect(heard).not.toContain('Loading prediction');
  });

  it('marks no row as next or upcoming', () => {
    expect(seen).not.toContain('Upcoming');
    expect(markup).not.toMatch(/>Next</);
  });

  it('renders no raw value anywhere', () => {
    expect(seen).not.toMatch(RAW_VALUE);
    expect(heard).not.toMatch(RAW_VALUE);
  });
});

describe('the team page’s other states', () => {
  it('names a bye week, and predicts the game after it (§10)', () => {
    const following = makeGame({ providerGameId: 'after-bye' });
    const { seen } = renderTeam({
      detail: detailWith({ nextGame: { kind: 'bye', week: 5, following } }),
      schedule: scheduleResponse(team),
      prediction: [
        'after-bye',
        predictionResponse(makePrediction({ providerGameId: 'after-bye' })),
      ],
    });
    expect(seen).toContain('Next game Bye week (week 5)');
    expect(seen).toContain('Alabama 67%');
  });

  it('marks the stale hero the way a stale card is marked (§39)', () => {
    const { seen } = renderTeam({
      detail: teamDetail(
        team,
        envelope(makeSnapshot(team), 'stale', null, '2026-10-01T15:00:00.000Z'),
      ),
      schedule: scheduleResponse(team),
    });
    expect(seen).toContain('May be out of date. Last updated:');
  });

  it('explains a missing team rather than showing an empty page', () => {
    const notFound = new ApiError(
      { kind: 'not_found', message: 'No such team.', requestId: 'r1' },
      404,
    );
    const { markup, seen } = renderTeam({ detail: notFound, schedule: notFound });
    expect(seen).toContain('Team not found');
    expect(seen).toContain('All boards');
    expect(markup).not.toContain('schedule');
  });

  it('shows a loading state, not a blank page, while the team is on its way', () => {
    const { heard } = renderTeam({});
    expect(heard).toContain('Loading team data…');
  });
});
