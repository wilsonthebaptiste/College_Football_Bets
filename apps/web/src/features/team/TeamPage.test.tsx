import type {
  PageTeam,
  PredictionResponse,
  TeamDetailResponse,
  TeamOwnersResponse,
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
  makeBoard,
  makeBoardTeam,
  makeGame,
  makeOwner,
  makePrediction,
  makeSnapshot,
  makeTeam,
  ownersResponse,
  predictionResponse,
  PROVIDER_DOWN,
  scheduleResponse,
  seasonItems,
  teamDetail,
} from '../../test/fixtures';
import { RAW_VALUE, renderAt, spokenText, visibleText } from '../../test/render';
import { SearchPage } from '../search/SearchPage';
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

describe('a loaded board paints the team page instantly, by either id', () => {
  /**
   * `useTeam`'s placeholder. Since Phase 1 a team has two addresses — our uuid
   * (what a board card links to) and the provider's id (what a search result
   * links to) — and a board already holds everything the team route returns.
   * Nothing is seeded under the team's own key here: whatever renders came
   * from the board.
   */
  function renderFromBoard(teamId: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
    client.setQueryData(
      queryKeys.board('u1'),
      makeBoard([makeBoardTeam(envelope(makeSnapshot(team)), team)]),
    );
    return visibleText(renderAt(`/teams/${teamId}`, '/teams/:teamId', <TeamPage />, client));
  }

  it('paints from the board when opened by our uuid, as it always has', () => {
    expectHeroAndPanels(renderFromBoard(team.id));
  });

  it('paints from the board when opened by the provider id, as search links do', () => {
    expectHeroAndPanels(renderFromBoard(team.providerTeamId));
  });

  it('still shows the loading state for a team no loaded board holds', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
    client.setQueryData(
      queryKeys.board('u1'),
      makeBoard([makeBoardTeam(envelope(makeSnapshot(team)), team)]),
    );
    const markup = renderAt('/teams/2382', '/teams/:teamId', <TeamPage />, client);
    expect(spokenText(markup)).toContain('Loading team data…');
    expect(visibleText(markup)).not.toContain('Alabama');
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

// ─── Phase 7 — "Picked by" in the hero ──────────────────────────────────────

const WILSON = makeOwner('Wilson', '11111111-1111-4111-8111-111111111111');
const JORDAN = makeOwner('Jordan', '22222222-2222-4222-8222-222222222222');

/**
 * The same team at its other address. A search result opens `/teams/333`, and
 * the response for that URL carries no uuid of ours at all (Phase 1) — which
 * is why the index is keyed on the provider's id and never on `team.id`.
 */
const searched: PageTeam = { ...team, id: null };

/** The pick index: an answer, a failure, or still on its way. */
type Index = TeamOwnersResponse | ApiError | undefined;

/** Renders the page at one of a team's two addresses, with the index seeded. */
function renderByUrl(teamId: string, subject: PageTeam, index: Index, live = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const snapshot = makeSnapshot(subject, live ? { liveGame: liveGame() } : {});
  client.setQueryData(queryKeys.team(teamId), teamDetail(subject, envelope(snapshot)));
  client.setQueryData(queryKeys.schedule(teamId), scheduleResponse(subject));
  if (index instanceof ApiError) seedError(client, queryKeys.owners, index);
  else if (index !== undefined) client.setQueryData(queryKeys.owners, index);

  const markup = renderAt(`/teams/${teamId}`, '/teams/:teamId', <TeamPage />, client);
  return { markup, seen: visibleText(markup), heard: spokenText(markup), client };
}

describe('exit 1 — the hero names the boards that hold this team, by both of its addresses', () => {
  const ONE_BOARD = ownersResponse({ '333': [WILSON] });

  it('by our uuid, which is the address a board card links to', () => {
    const { markup, seen } = renderByUrl(team.id, team, ONE_BOARD);
    expect(seen).toContain('Picked by Wilson');
    expect(markup).toContain(`href="/u/${WILSON.userId}"`);
    expectHeroAndPanels(seen);
  });

  it('by the provider’s id, which is the address a search result links to', () => {
    const { markup, seen } = renderByUrl(searched.providerTeamId, searched, ONE_BOARD);
    expect(seen).toContain('Picked by Wilson');
    expect(markup).toContain(`href="/u/${WILSON.userId}"`);
    expectHeroAndPanels(seen);
  });

  /**
   * The counterfactual for the criterion above: keyed on `team.id`, the uuid
   * page would find this entry and the searched page would look up `null`.
   * Keyed on the provider's id, neither does.
   */
  it('reads the index by the provider’s id, never by our uuid', () => {
    const byUuid = ownersResponse({ [team.id]: [WILSON] });
    expect(renderByUrl(team.id, team, byUuid).seen).not.toContain('Picked by');
    expect(renderByUrl(searched.providerTeamId, searched, byUuid).seen).not.toContain('Picked by');
  });

  it('names both boards when two have it, in the order the index gives', () => {
    const { seen } = renderByUrl(team.id, team, ownersResponse({ '333': [JORDAN, WILSON] }));
    expect(seen).toContain('Picked by Jordan Wilson');
  });

  /**
   * Stated as an identity rather than as an absence: the hero of a team nobody
   * picked is the same markup the page produced before this phase. Most of the
   * ~762 teams are this case, so it is the ordinary page, not a degraded one.
   */
  it('leaves the hero exactly as Phase 4 left it for a team nobody has picked', () => {
    const others = renderByUrl(team.id, team, ownersResponse({ '2641': [WILSON] }));
    const noIndexAtAll = renderByUrl(team.id, team, undefined);
    expect(others.markup).toBe(noIndexAtAll.markup);
    expect(others.seen).not.toContain('Picked by');
    expectHeroAndPanels(others.seen);
    expect(others.seen).not.toMatch(RAW_VALUE);
  });
});

describe('exit 2 — the line sits in the identity card, and moves nothing else', () => {
  const { markup, seen } = renderByUrl(team.id, team, ownersResponse({ '333': [WILSON] }), true);

  it('follows the team’s name and precedes the card’s own footer', () => {
    expect(seen.indexOf('Alabama Crimson Tide, SEC')).toBeLessThan(seen.indexOf('Picked by'));
    expect(seen.indexOf('Picked by')).toBeLessThan(seen.indexOf('2026 season, week 5'));
  });

  it('leaves a game in progress ahead of everything below the card (§11, §51)', () => {
    expect(seen.indexOf('2026 season, week 5')).toBeLessThan(seen.indexOf('LIVE'));
    expect(seen.indexOf('LIVE')).toBeLessThan(seen.indexOf('Previous game'));
  });

  it('adds no second heading and no raw value', () => {
    expect(headings(markup)).toEqual([
      'h1:Alabama',
      'h2:Previous game',
      'h2:Next game',
      'h2:Matchup prediction',
      'h2:2026 schedule',
    ]);
    expect(seen).not.toMatch(RAW_VALUE);
    expect(spokenText(markup)).not.toMatch(RAW_VALUE);
  });
});

describe('exit 3 — the index is garnish here too: it degrades, it never fails (§38, §42)', () => {
  const DB_DOWN = new ApiError(
    {
      kind: 'internal',
      message: 'The application database is temporarily unreachable.',
      requestId: 'req-db',
    },
    500,
  );

  /**
   * The symptom of a broken index is the absence of a line, which is exactly
   * what "nobody has this team" looks like. That is the design, and the reason
   * it is drilled here rather than trusted.
   */
  it('renders the whole page with the index failed, and says nothing about it', () => {
    const { markup, seen } = renderByUrl(team.id, team, DB_DOWN);
    expectHeroAndPanels(seen);
    expect(seen).toContain('W 34–17');
    expect(seen).not.toContain('Picked by');
    expect(markup).not.toContain('role="alert"');
    expect(seen).not.toContain('temporarily unreachable');
    expect(seen).not.toContain('req-db');
    expect(headings(markup)).toHaveLength(5);
    expect(seen).not.toMatch(RAW_VALUE);
  });

  it('renders the whole page with the index still on its way', () => {
    const { markup, seen, heard } = renderByUrl(team.id, team, undefined);
    expectHeroAndPanels(seen);
    expect(seen).not.toContain('Picked by');
    expect(markup).not.toContain('role="alert"');
    // Nothing waits for it, so nothing announces waiting for it either.
    expect(heard).not.toMatch(/loading.*(board|picked|owner)/i);
  });
});

describe('exit 4 — one index request per document, whatever it is read for', () => {
  function ownerKeys(client: QueryClient): readonly (readonly unknown[])[] {
    return client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey)
      .filter((key) => key[0] === 'owners');
  }

  it('asks under one key however many team pages a document opens', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
    for (const teamId of ['333', '251', '2641']) {
      const subject = makeTeam({ providerTeamId: teamId });
      client.setQueryData(
        queryKeys.team(teamId),
        teamDetail(subject, envelope(makeSnapshot(subject))),
      );
      renderAt(`/teams/${teamId}`, '/teams/:teamId', <TeamPage />, client);
    }
    expect(ownerKeys(client)).toEqual([queryKeys.owners]);
  });

  /**
   * The two callers share one request: the key is a constant in `lib/`, not a
   * page's own. Arriving at a team page from a search costs no extra read.
   */
  it('asks under that same key from the search page and the team page alike', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
    renderAt('/search?q=texas', '/search', <SearchPage />, client);
    client.setQueryData(queryKeys.team('333'), teamDetail(team, envelope(makeSnapshot(team))));
    renderAt('/teams/333', '/teams/:teamId', <TeamPage />, client);
    expect(ownerKeys(client)).toEqual([queryKeys.owners]);
  });
});
