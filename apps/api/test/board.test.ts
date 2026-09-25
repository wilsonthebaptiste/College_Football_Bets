import type {
  ApiErrorBody,
  BoardResponse,
  GameResponse,
  HealthResponse,
  PredictionResponse,
  SeasonMetaResponse,
  TeamDetailResponse,
  TeamOwnersResponse,
  TeamScheduleResponse,
  TeamSearchResponse,
} from '@cfb/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetJwksCache } from '../src/auth/jwks';
import { createApp } from '../src/app';
import { resetInflight } from '../src/cache/swr';
import { resetCacheTiers } from '../src/cache/tiers';
import type { Env } from '../src/env';
import { generateSeason } from '../src/providers/mock/generate';
import { SEARCH_LIMIT, SEARCH_MAX_LENGTH } from '../src/services/search';
import {
  ALL_TEAM_ROWS,
  JORDAN,
  JORDAN_ID,
  JORDAN_TEAMS,
  WILSON,
  WILSON_ID,
  WILSON_TEAMS,
  ownerRow,
  ownerRows,
  teamUuid,
  userRow,
} from './helpers/boards';
import { espnResponse, type EspnStubOptions } from './helpers/espn-stub';
import { CAPTURED_AT } from './helpers/fixtures';
import { FakeKv } from './helpers/kv';
import {
  installSupabaseStub,
  TEST_ISSUER,
  testEnv,
  type SupabaseStub,
} from './helpers/supabase-stub';
import { generateSigningKey, nowSeconds, signToken, type SigningKeyPair } from './helpers/tokens';

/**
 * Phase 2 route tests: the plan's exit criteria, as assertions.
 *
 * Mock-provider tests pin the clock to a Wednesday in mock week 6. ESPN tests
 * pin it to the moment the Phase 1 fixtures were captured, so "previous" and
 * "next" mean what they meant then.
 */

const MOCK_NOW = '2026-10-07T18:00:00Z';

const app = createApp();
let stub: SupabaseStub;
let signingKey: SigningKeyPair;

beforeAll(async () => {
  signingKey = await generateSigningKey('ES256', 'test-key');
});

beforeEach(() => {
  resetCacheTiers();
  resetInflight();
  resetJwksCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(MOCK_NOW));
  // Stale fallbacks and injected faults log by design; keep the output readable.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  stub.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function get<T>(path: string, env: Env = testEnv(), headers: Record<string, string> = {}) {
  const response = await app.request(path, { headers }, env);
  return { response, body: (await response.json()) as T };
}

function stubWith(
  options: { users?: unknown[]; espn?: EspnStubOptions; jwks?: boolean; isAdmin?: boolean } = {},
) {
  stub = installSupabaseStub({
    appUsers: options.users ?? [WILSON, JORDAN],
    teams: ALL_TEAM_ROWS,
    external: (url) => espnResponse(url, options.espn ?? {}),
    ...(options.jwks === true ? { jwks: { keys: [signingKey.jwk] } } : {}),
    ...(options.isAdmin === undefined ? {} : { isAdmin: options.isAdmin }),
  });
  return stub;
}

const advanceMinutes = (minutes: number): void => {
  vi.setSystemTime(new Date(Date.now() + minutes * 60_000));
};

// ─── Every read route is public ──────────────────────────────────────────────

describe('every Phase 2 read route answers 200 with no token at all (§11.1)', () => {
  it('board, team, schedule, game, prediction', async () => {
    stubWith({ jwks: true });
    const mockGame = generateSeason({ year: 2026, type: 'regular', week: 6 }, Date.now())[0]!;
    const paths = [
      `/api/users/${WILSON_ID}/board`,
      `/api/teams/${teamUuid('333')}`,
      `/api/teams/${teamUuid('333')}/schedule`,
      `/api/games/${mockGame.providerGameId}`,
      `/api/games/${mockGame.providerGameId}/prediction`,
    ];
    for (const path of paths) {
      const { response } = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('X-Request-Id'), path).toBeTruthy();
      expect(response.headers.get('X-Cache'), path).toMatch(/^(hit|miss|stale)$/);
      expect(response.headers.get('Cache-Control'), path).toMatch(
        /^public, max-age=\d+$|^no-store$/,
      );
    }
    // The public path never touches JWT machinery.
    expect(stub.jwksFetches).toBe(0);
    expect(stub.restRequests.every((request) => request.authorization === null)).toBe(true);
  });
});

// ─── The board ───────────────────────────────────────────────────────────────

describe('GET /api/users/:userId/board (§13, §27)', () => {
  it('returns all six teams in board order, each with rank, record, previous, and next', async () => {
    stubWith();
    const { response, body } = await get<BoardResponse>(`/api/users/${WILSON_ID}/board`);

    expect(response.status).toBe(200);
    expect(body.user).toEqual({ id: WILSON_ID, displayName: 'Wilson' });
    expect(body.season).toMatchObject({ year: 2026, type: 'regular', week: 6 });
    expect(body.teams.map((team) => team.team.providerTeamId)).toEqual(WILSON_TEAMS);
    expect(body.teams.map((team) => team.order)).toEqual([1, 2, 3, 4, 5, 6]);

    for (const team of body.teams) {
      const snapshot = team.snapshot.data;
      expect(snapshot, team.team.name).not.toBeNull();
      expect(team.snapshot.error).toBeNull();
      expect(team.snapshot.freshness).toMatchObject({ state: 'fresh', provider: 'mock' });
      expect(['ranked', 'unranked']).toContain(snapshot!.ranking.kind);
      expect(snapshot!.record?.summary).toMatch(/^\d+-\d+$/);
      expect(snapshot!.previousGame?.status).toBe('final');
      expect(['game', 'bye']).toContain(snapshot!.nextGame.kind);
      // Identity is Postgres's, not the provider's (§45).
      expect(snapshot!.identity.logoUrl).toBe(team.team.logoUrl);
    }
    expect(body.anyLive).toBe(body.teams.some((team) => team.snapshot.data?.liveGame != null));
  });

  it('is one browser request: one Postgres query, all six teams inside it', async () => {
    stubWith();
    await get(`/api/users/${WILSON_ID}/board`);
    expect(stub.restRequests).toHaveLength(1);
  });

  it('absorbs polling: a second read inside the TTL is a cache hit that touches nothing', async () => {
    stubWith();
    const first = await get<BoardResponse>(`/api/users/${WILSON_ID}/board`);
    expect(first.response.headers.get('X-Cache')).toBe('miss');

    // Inside even the live TTL (15 s): one of Wilson's teams is mid-game at MOCK_NOW.
    advanceMinutes(10 / 60);
    const second = await get<BoardResponse>(`/api/users/${WILSON_ID}/board`);
    expect(second.response.headers.get('X-Cache')).toBe('hit');
    expect(stub.restRequests).toHaveLength(1);
    // Served from cache now, so no longer "fresh", and the timestamp is unchanged.
    const [before, after] = [
      first.body.teams[0]!.snapshot.freshness,
      second.body.teams[0]!.snapshot.freshness,
    ];
    expect(after.state).toBe('cached');
    expect(after.fetchedAt).toBe(before.fetchedAt);
    expect(
      Number(/max-age=(\d+)/.exec(second.response.headers.get('Cache-Control') ?? '')?.[1]),
    ).toBeLessThanOrEqual(60);
  });

  it('polls faster while a team is live: anyLive, and a 15 s board TTL (§24)', async () => {
    stubWith();
    const season = { year: 2026, type: 'regular' as const, week: 6 };
    const live = generateSeason(season, Date.now()).find((game) => game.status === 'live')!;
    const liveUser = userRow(3, 'Live Fan', [live.home.team.providerTeamId, '251']);
    stubWith({ users: [liveUser] });

    const { response, body } = await get<BoardResponse>(
      `/api/users/${liveUser['id'] as string}/board`,
    );
    expect(body.anyLive).toBe(true);
    const liveTeam = body.teams[0]!.snapshot.data!;
    expect(liveTeam.liveGame).toMatchObject({ status: 'live', result: null });
    expect(liveTeam.liveGame?.period).toBeGreaterThanOrEqual(1);
    expect(liveTeam.previousGame?.providerGameId).not.toBe(liveTeam.liveGame?.providerGameId);
    expect(body.freshness.ttlSeconds).toBe(15);
    expect(
      Number(/max-age=(\d+)/.exec(response.headers.get('Cache-Control') ?? '')?.[1]),
    ).toBeLessThanOrEqual(15);
  });

  it('is a 404 for a user that does not exist, and for a malformed id', async () => {
    stubWith({ users: [] });
    const missing = await get<ApiErrorBody>(`/api/users/${WILSON_ID}/board`);
    expect(missing.response.status).toBe(404);
    expect(missing.body.error.kind).toBe('not_found');

    const malformed = await app.request('/api/users/not-a-uuid/board', {}, testEnv());
    expect(malformed.status).toBe(404);
  });
});

// ─── Error isolation ─────────────────────────────────────────────────────────

describe('one failure does not take the board with it (§38, §42)', () => {
  it('forcing one team to fail leaves the other five intact', async () => {
    stubWith();
    const { response, body } = await get<BoardResponse>(
      `/api/users/${WILSON_ID}/board`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'team:251' }),
    );
    expect(response.status).toBe(200);

    const failed = body.teams.filter((team) => team.snapshot.data === null);
    expect(failed.map((team) => team.team.providerTeamId)).toEqual(['251']);
    expect(failed[0]!.snapshot.error?.kind).toBe('provider_unavailable');
    expect(failed[0]!.snapshot.error?.message).toBe('Sports data temporarily unavailable.');
    // The card can still say whose card it is.
    expect(failed[0]!.team.name).toBe('Texas Longhorns');
    expect(body.teams.filter((team) => team.snapshot.data !== null)).toHaveLength(5);
  });

  it('missing rankings show as unavailable ("—"), never as unranked ("NR") (§7)', async () => {
    stubWith();
    const { body } = await get<BoardResponse>(
      `/api/users/${WILSON_ID}/board`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'rankings' }),
    );
    for (const team of body.teams) {
      expect(team.snapshot.data?.ranking).toEqual({ kind: 'unavailable' });
      expect(team.snapshot.data?.record).not.toBeNull();
    }
  });

  it('with the provider down and nothing cached: still a 200, every card unavailable', async () => {
    stubWith();
    const { response, body } = await get<BoardResponse>(
      `/api/users/${WILSON_ID}/board`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'all' }),
    );
    expect(response.status).toBe(200);
    expect(body.teams).toHaveLength(6);
    for (const team of body.teams) {
      expect(team.snapshot).toMatchObject({
        data: null,
        freshness: { state: 'unavailable', fetchedAt: null },
      });
      expect(team.snapshot.error?.kind).toBe('provider_unavailable');
      expect(team.snapshot.error?.requestId).toBe(response.headers.get('X-Request-Id'));
    }
  });

  it('a board with a failing card is short-lived, so it recovers within seconds', async () => {
    stubWith();
    const first = await get<BoardResponse>(
      `/api/users/${WILSON_ID}/board`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'team:251' }),
    );
    expect(first.body.teams.filter((team) => team.snapshot.data === null)).toHaveLength(1);
    // Not a full minute in a browser or edge cache...
    expect(first.response.headers.get('Cache-Control')).toBe('public, max-age=10');

    // ...and 15 s in the Worker. The provider has recovered, but inside that
    // window the board is still the cached one.
    vi.setSystemTime(new Date(Date.now() + 10_000));
    const cached = await get<BoardResponse>(`/api/users/${WILSON_ID}/board`);
    expect(cached.response.headers.get('X-Cache')).toBe('hit');
    expect(cached.body.teams.filter((team) => team.snapshot.data === null)).toHaveLength(1);

    vi.setSystemTime(new Date(Date.now() + 6_000));
    const recovered = await get<BoardResponse>(`/api/users/${WILSON_ID}/board`);
    expect(recovered.response.headers.get('X-Cache')).toBe('miss');
    expect(recovered.body.teams.every((team) => team.snapshot.data !== null)).toBe(true);
    // Back to the ordinary lifetime: the live 15 s (a Wilson team is mid-game), not the degraded 10 s.
    expect(recovered.response.headers.get('Cache-Control')).toBe('public, max-age=15');
  });
});

// ─── Stale data (§39) ────────────────────────────────────────────────────────

describe('provider down + warm cache → stale, with the original timestamps (§39)', () => {
  it('serves the cached board flagged stale, fetchedAt unchanged', async () => {
    stubWith();
    const warm = await get<BoardResponse>(`/api/users/${WILSON_ID}/board`);
    const originals = warm.body.teams.map((team) => team.snapshot.freshness.fetchedAt);
    expect(originals.every((at) => at === new Date(MOCK_NOW).toISOString())).toBe(true);

    advanceMinutes(120); // past every TTL on the board, inside every stale window
    const { response, body } = await get<BoardResponse>(
      `/api/users/${WILSON_ID}/board`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'all' }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Cache')).toBe('stale');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=10');
    body.teams.forEach((team, index) => {
      expect(team.snapshot.data).not.toBeNull();
      expect(team.snapshot.freshness.state).toBe('stale');
      expect(team.snapshot.freshness.source).toBe('cache');
      expect(team.snapshot.freshness.fetchedAt).toBe(originals[index]);
    });
  });

  it('keeps serving the last board if Postgres fails inside the board’s stale window', async () => {
    stubWith();
    await get(`/api/users/${WILSON_ID}/board`);
    advanceMinutes(2);
    stub.restore();
    stub = installSupabaseStub({ restFailure: 500 });

    const { response, body } = await get<BoardResponse>(`/api/users/${WILSON_ID}/board`);
    expect(response.status).toBe(200);
    expect(body.freshness.state).toBe('stale');
    expect(body.teams).toHaveLength(6);
  });

  it('answers Postgres failure with no cached board as a plain 500, not a fake board', async () => {
    stub = installSupabaseStub({ restFailure: 500 });
    const { response, body } = await get<ApiErrorBody>(`/api/users/${WILSON_ID}/board`);
    expect(response.status).toBe(500);
    expect(body.error.kind).toBe('internal');
  });
});

// ─── The KV budget ───────────────────────────────────────────────────────────

describe('KV write budget (plan §7)', () => {
  it('records zero KV writes for live games or board composites', async () => {
    stubWith();
    const kv = new FakeKv();
    const env = testEnv({ SPORTS_KV: kv.asNamespace() });
    const live = generateSeason({ year: 2026, type: 'regular', week: 6 }, Date.now()).find(
      (game) => game.status === 'live',
    )!;
    stubWith({ users: [WILSON, userRow(3, 'Live Fan', [live.home.team.providerTeamId])] });

    await get(`/api/users/${WILSON_ID}/board`, env);
    await get(`/api/users/${userRow(3, 'x', [])['id'] as string}/board`, env);
    advanceMinutes(20);
    await get(`/api/users/${WILSON_ID}/board`, env);

    const { body: health } = await get<HealthResponse>('/api/health', env);
    expect(health.cache.kvWrites.byCategory['live_game']).toBeUndefined();
    expect(health.cache.kvWrites.byCategory['board_composite']).toBeUndefined();
    expect(health.cache.kvWrites.byCategory['schedule']).toBeGreaterThan(0);

    expect(
      kv.writes.some((write) => write.key.includes('|slate|') || write.key.includes('|board|')),
    ).toBe(false);
    expect(kv.writes.every((write) => write.expirationTtl >= 300)).toBe(true);
  });
});

// ─── ESPN end to end, over the captured fixtures ─────────────────────────────

describe('SPORTS_PROVIDER=espn over the Phase 1 captures', () => {
  const espnEnv = (overrides: Partial<Env> = {}): Env =>
    testEnv({ SPORTS_PROVIDER: 'espn', ...overrides });
  const texasAndPitt = userRow(4, 'Fixture Fan', ['251', '221', '333']);
  const texasAndPittAgain = userRow(5, 'Second Fan', ['221', '251']);

  beforeEach(() => {
    vi.setSystemTime(new Date(CAPTURED_AT));
  });

  it('builds the board from real ESPN payloads', async () => {
    stubWith({ users: [texasAndPitt] });
    const { response, body } = await get<BoardResponse>(
      `/api/users/${texasAndPitt['id'] as string}/board`,
      espnEnv(),
    );
    expect(response.status).toBe(200);
    expect(body.season).toEqual({ year: 2026, type: 'regular', week: 3 });

    const [texas, pitt, alabama] = body.teams.map((team) => team.snapshot);
    expect(texas!.data).toMatchObject({
      ranking: { kind: 'ranked', rank: 1, poll: 'AP Top 25', week: 3 },
      record: { summary: '2-0' },
      previousGame: { result: 'W', teamScore: 24, opponentScore: 23, homeAway: 'home' },
      nextGame: { kind: 'game', game: { week: 3, kickoffUtc: '2026-09-20T00:00:00.000Z' } },
      liveGame: null,
    });
    expect(texas!.freshness.provider).toBe('espn');
    expect(pitt!.data).toMatchObject({ ranking: { kind: 'unranked' }, record: { summary: '3-0' } });

    // No fixture for Alabama: ESPN "404s" it. One card fails; the board does not.
    expect(alabama).toMatchObject({ data: null, error: { kind: 'not_found' } });
  });

  it('fetches the calendar and the rankings once for the whole board', async () => {
    stubWith({ users: [texasAndPitt] });
    await get(`/api/users/${texasAndPitt['id'] as string}/board`, espnEnv());
    const paths = stub.espnRequests.map((request) =>
      new URL(request.url).pathname.split('/').pop(),
    );
    expect(paths.filter((path) => path === 'rankings')).toHaveLength(1);
    expect(paths.filter((path) => path === 'scoreboard')).toHaveLength(1);
    expect(paths.filter((path) => path === 'schedule')).toHaveLength(3);
  });

  it('asks ESPN once for a team shared by two boards loading at the same moment (§27)', async () => {
    stubWith({ users: [texasAndPitt, texasAndPittAgain] });
    await Promise.all([
      get(`/api/users/${texasAndPitt['id'] as string}/board`, espnEnv()),
      get(`/api/users/${texasAndPittAgain['id'] as string}/board`, espnEnv()),
    ]);
    const texasSchedules = stub.espnRequests.filter((request) =>
      request.url.includes('/teams/251/schedule'),
    );
    expect(texasSchedules).toHaveLength(1);
  });

  it('goes stale, not blank, when ESPN goes down after the cache is warm', async () => {
    stubWith({ users: [texasAndPitt] });
    const warm = await get<BoardResponse>(
      `/api/users/${texasAndPitt['id'] as string}/board`,
      espnEnv(),
    );
    advanceMinutes(90);
    const { body } = await get<BoardResponse>(
      `/api/users/${texasAndPitt['id'] as string}/board`,
      espnEnv({ SPORTS_PROVIDER_FAULT: 'all' }),
    );
    const texas = body.teams[0]!.snapshot;
    expect(texas.freshness.state).toBe('stale');
    expect(texas.freshness.fetchedAt).toBe(warm.body.teams[0]!.snapshot.freshness.fetchedAt);
    expect(texas.data?.ranking).toMatchObject({ kind: 'ranked', rank: 1 });
  });

  it('serves the full schedule with the bye as a row (§17)', async () => {
    stubWith();
    const { body } = await get<TeamScheduleResponse>(
      `/api/teams/${teamUuid('251')}/schedule`,
      espnEnv(),
    );
    const items = body.schedule.data!.items;
    expect(items).toHaveLength(13);
    expect(items[4]).toEqual({ kind: 'bye', week: 5 });
    expect(body.team.name).toBe('Texas Longhorns');
  });

  it('predictions: inline, standalone, and absent (§12)', async () => {
    stubWith({ espn: { predictors: ['401858225'] } });
    const inline = await get<PredictionResponse>('/api/games/401858226/prediction', espnEnv());
    expect(inline.body.prediction.data).toMatchObject({
      homeWinPct: 8.3,
      awayWinPct: 91.7,
      sourceLabel: 'ESPN Matchup Predictor',
    });

    const standalone = await get<PredictionResponse>('/api/games/401858225/prediction', espnEnv());
    expect(standalone.body.prediction.data).toMatchObject({ homeWinPct: 82.5, awayWinPct: 17.5 });

    stubWith({ espn: { predictors: [] } });
    resetCacheTiers();
    const absent = await get<PredictionResponse>('/api/games/401858225/prediction', espnEnv());
    expect(absent.response.status).toBe(200);
    expect(absent.body.prediction).toMatchObject({ data: null, error: null });
    expect(absent.body.prediction.freshness.state).toBe('fresh');
  });

  it('a game that does not exist is a 404', async () => {
    stubWith();
    const { response, body } = await get<ApiErrorBody>('/api/games/123/prediction', espnEnv());
    expect(response.status).toBe(404);
    expect(body.error.kind).toBe('not_found');
  });
});

// ─── Team and game routes ────────────────────────────────────────────────────

describe('team routes (§16, §17)', () => {
  it('GET /api/teams/:id — identity plus snapshot', async () => {
    stubWith();
    const { body } = await get<TeamDetailResponse>(`/api/teams/${teamUuid('61')}`);
    expect(body.team).toMatchObject({
      providerTeamId: '61',
      name: 'Georgia Bulldogs',
      conference: 'SEC',
    });
    expect(body.snapshot.data?.previousGame?.status).toBe('final');
    expect(body.season.week).toBe(6);
  });

  it('a failed schedule leaves the team identity standing (§42)', async () => {
    stubWith();
    const { response, body } = await get<TeamScheduleResponse>(
      `/api/teams/${teamUuid('61')}/schedule`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'schedule' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.team.name).toBe('Georgia Bulldogs');
    expect(body.schedule).toMatchObject({ data: null, error: { kind: 'provider_unavailable' } });
  });

  it('404s an unknown team and a malformed id', async () => {
    stubWith();
    // A uuid with no row, and a provider id the provider does not list. The
    // second reads as "no such team" on both paths now, not "not a uuid".
    expect((await app.request(`/api/teams/${teamUuid('1')}`, {}, testEnv())).status).toBe(404);
    expect((await app.request('/api/teams/texas', {}, testEnv())).status).toBe(404);
  });
});

// ─── A team page for any team (plan-search-engine, Phase 1) ──────────────────

describe('GET /api/teams/:teamId takes a provider team id as well as our uuid', () => {
  /**
   * Nobody's board, and no `teams` row at all: this is a team the site could
   * previously not show. `2` is Auburn in the mock roster.
   */
  const AUBURN = '2';

  const noRows = (): SupabaseStub =>
    installSupabaseStub({
      appUsers: [],
      teams: [],
      external: (url) => espnResponse(url, {}),
    });

  it('serves a team with no row of ours: 200, id null, and a whole snapshot', async () => {
    stub = noRows();
    const { response, body } = await get<TeamDetailResponse>(`/api/teams/${AUBURN}`);

    expect(response.status).toBe(200);
    expect(body.team).toMatchObject({
      id: null,
      providerTeamId: AUBURN,
      name: 'Auburn Tigers',
      displayName: 'Auburn',
      conference: 'SEC',
    });
    expect(body.season.week).toBe(6);

    const snapshot = body.snapshot.data;
    expect(body.snapshot.error).toBeNull();
    expect(snapshot?.record?.summary).toMatch(/^\d+-\d+$/);
    expect(snapshot?.previousGame?.status).toBe('final');
    expect(['game', 'bye']).toContain(snapshot?.nextGame.kind);
    expect(['ranked', 'unranked']).toContain(snapshot?.ranking.kind);
  });

  it('serves its schedule too, with the same id: null', async () => {
    stub = noRows();
    const { response, body } = await get<TeamScheduleResponse>(`/api/teams/${AUBURN}/schedule`);

    expect(response.status).toBe(200);
    expect(body.team).toMatchObject({ id: null, name: 'Auburn Tigers' });
    const items = body.schedule.data!.items;
    expect(items.length).toBeGreaterThan(8);
    expect(items.some((item) => item.kind === 'game')).toBe(true);
  });

  it('touches Postgres not at all — no public path may create a `teams` row (§30, §31)', async () => {
    stub = noRows();
    await get(`/api/teams/${AUBURN}`);
    await get(`/api/teams/${AUBURN}/schedule`);

    // Not "no write": no request whatsoever. A row cannot be created by a
    // client that was never built.
    expect(stub.restRequests).toHaveLength(0);
    expect(stub.jwksFetches).toBe(0);
  });

  it('answers the same sports facts either way: the id is the only difference', async () => {
    stubWith();
    const stored = await get<TeamDetailResponse>(`/api/teams/${teamUuid('61')}`);
    const searched = await get<TeamDetailResponse>('/api/teams/61');

    expect(stored.body.team.id).toBe(teamUuid('61'));
    expect(searched.body.team.id).toBeNull();

    // Deliberately not a deep-equal: the stored row says provider `espn` and
    // carries a curated logo, while `listTeams()` in mock mode says `mock`
    // (teamNamespace). Nothing renders either field. What must agree is the
    // sports half, which is keyed by providerTeamId on both paths.
    const facts = (detail: TeamDetailResponse) => ({
      record: detail.snapshot.data?.record,
      ranking: detail.snapshot.data?.ranking,
      previousGame: detail.snapshot.data?.previousGame,
      nextGame: detail.snapshot.data?.nextGame,
    });
    expect(facts(searched.body)).toEqual(facts(stored.body));
    expect(searched.body.team.name).toBe(stored.body.team.name);
  });

  it('the uuid is resolved first and never falls through to the provider list', async () => {
    // A uuid matches the provider-id pattern too. If a deleted row fell
    // through, this would quietly become a 200 for "provider team
    // 00000000-0000-4000-8000-000000000001".
    stub = noRows();
    const { response, body } = await get<ApiErrorBody>(`/api/teams/${teamUuid('1')}`);
    expect(response.status).toBe(404);
    expect(body.error.kind).toBe('not_found');
    // It asked Postgres, and stopped there.
    expect(stub.restRequests.map((request) => request.path.split('?')[0])).toEqual([
      '/rest/v1/teams',
    ]);
  });

  it('404s an unknown provider id, a malformed one, and an over-long one', async () => {
    stub = noRows();
    for (const id of ['999999', 'texas!', 'a'.repeat(41)]) {
      const response = await app.request(`/api/teams/${id}`, {}, testEnv());
      expect(response.status, id).toBe(404);
      expect((await response.json<ApiErrorBody>()).error.kind, id).toBe('not_found');
    }
    // The two rejected on shape never reached the provider's list.
    expect(stub.restRequests).toHaveLength(0);
  });

  it('is a clean error, not a blank page, when the team list cannot be read', async () => {
    // The asymmetry this phase accepts: a board team's identity survives a
    // provider outage because it is in Postgres, a searched team's does not.
    stub = noRows();
    const { response, body } = await get<ApiErrorBody>(
      `/api/teams/${AUBURN}`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'teams' }),
    );
    expect(response.status).toBe(503);
    expect(body.error.kind).toBe('provider_unavailable');
    expect(body.error.requestId).toBe(response.headers.get('X-Request-Id'));
    // `TeamPage` renders this string. It must not say a search failed.
    expect(body.error.message).toBe('Team information is temporarily unavailable.');
    expect(body.error.message).not.toMatch(/search/i);
  });

  it('still answers without a database: a searched team needs none', async () => {
    stub = noRows();
    const unconfigured = testEnv({ SUPABASE_URL: '', SUPABASE_ANON_KEY: '' });

    expect((await app.request(`/api/teams/${AUBURN}`, {}, unconfigured)).status).toBe(200);
    // And a malformed id is still a clean 404, not a configuration 500.
    expect((await app.request('/api/teams/texas!', {}, unconfigured)).status).toBe(404);
  });

  it('never puts our uuid inside snapshot.identity, on any board card', async () => {
    // `buildSnapshot` now takes a TeamIdentity, so a `Team` passed straight
    // through would leak `id` onto the wire for all 54 cards. TypeScript
    // cannot see that — excess properties survive at runtime — so assert it.
    stubWith();
    const { body } = await get<BoardResponse>(`/api/users/${WILSON_ID}/board`);
    expect(body.teams).toHaveLength(6);
    for (const { team, snapshot } of body.teams) {
      expect(snapshot.data).not.toBeNull();
      expect('id' in snapshot.data!.identity).toBe(false);
      expect(team.id).toBe(teamUuid(team.providerTeamId));
    }
  });

  describe('over real ESPN payloads', () => {
    const espnEnv = (): Env => testEnv({ SPORTS_PROVIDER: 'espn' });

    beforeEach(() => {
      vi.setSystemTime(new Date(CAPTURED_AT));
    });

    it('shares every expensive read between the two URLs for one team', async () => {
      stubWith();
      const first = await get<TeamDetailResponse>(`/api/teams/${teamUuid('251')}`, espnEnv());
      expect(first.response.headers.get('X-Cache')).toBe('miss');

      const second = await get<TeamDetailResponse>('/api/teams/251', espnEnv());
      expect(second.response.headers.get('X-Cache')).toBe('hit');

      // Cache keys are provider-id based, so the second URL pays for none of it.
      const schedules = stub.espnRequests.filter((request) =>
        request.url.includes('/teams/251/schedule'),
      );
      expect(schedules).toHaveLength(1);
      expect(second.body.snapshot.data?.record).toEqual(first.body.snapshot.data?.record);
    });

    it('invents nothing for a team outside the FBS conference map (§4, §46)', async () => {
      // Abilene Christian is in ESPN's 762-team list and in no conference group.
      stubWith();
      const { response, body } = await get<TeamDetailResponse>('/api/teams/2000', espnEnv());

      expect(response.status).toBe(200);
      expect(body.team).toMatchObject({
        id: null,
        providerTeamId: '2000',
        name: 'Abilene Christian Wildcats',
        // Not guessed, not "FCS", not an empty string. The map is FBS-only.
        conference: null,
      });
    });
  });
});

describe('game routes', () => {
  const season = { year: 2026, type: 'regular' as const, week: 6 };

  it('tells the score from the requested side, or the home side by default', async () => {
    stubWith();
    const final = generateSeason(season, Date.now()).find((game) => game.status === 'final')!;
    const home = await get<GameResponse>(`/api/games/${final.providerGameId}`);
    expect(home.body.game.data).toMatchObject({
      homeAway: final.neutralSite ? 'neutral' : 'home',
      teamScore: final.home.score,
    });

    const away = await get<GameResponse>(
      `/api/games/${final.providerGameId}?team=${final.away.team.providerTeamId}`,
    );
    expect(away.body.game.data).toMatchObject({
      teamScore: final.away.score,
      opponentScore: final.home.score,
    });
    // A final game is cached for a week (§23).
    expect(away.body.game.freshness.ttlSeconds).toBe(7 * 24 * 60 * 60);
  });

  it('refuses a perspective team that is not in the game', async () => {
    stubWith();
    const game = generateSeason(season, Date.now())[0]!;
    const { response } = await get<ApiErrorBody>(`/api/games/${game.providerGameId}?team=999`);
    expect(response.status).toBe(400);
  });

  it('labels mock predictions as mock (§46)', async () => {
    stubWith();
    const games = generateSeason(season, Date.now());
    const bodies = await Promise.all(
      games
        .slice(0, 12)
        .map((game) => get<PredictionResponse>(`/api/games/${game.providerGameId}/prediction`)),
    );
    const present = bodies.map(({ body }) => body.prediction.data).filter((data) => data !== null);
    expect(present.length).toBeGreaterThan(0);
    expect(present.every((prediction) => prediction.source === 'mock_predictor')).toBe(true);
  });
});

// ─── Phase 4: the team page's reads ──────────────────────────────────────────

describe('the team page’s three reads, live (§11, §16, §17)', () => {
  const season = { year: 2026, type: 'regular' as const, week: 6 };

  it('agree on a live game, and date its score by its own live read (§23)', async () => {
    stubWith();
    const live = generateSeason(season, Date.now()).find((game) => game.status === 'live')!;
    const teamId = teamUuid(live.home.team.providerTeamId);

    const detail = await get<TeamDetailResponse>(`/api/teams/${teamId}`);
    const snapshot = detail.body.snapshot.data!;
    expect(snapshot.liveGame).toMatchObject({
      providerGameId: live.providerGameId,
      status: 'live',
      result: null,
    });
    expect(snapshot.liveGame?.period).toBeGreaterThanOrEqual(1);
    expect(snapshot.liveGame?.clock).toMatch(/^\d{1,2}:\d{2}$/);
    expect(snapshot.liveUpdatedAt).toBe(new Date(MOCK_NOW).toISOString());

    const schedule = await get<TeamScheduleResponse>(`/api/teams/${teamId}/schedule`);
    const row = schedule.body.schedule.data?.items.find(
      (item) => item.kind === 'game' && item.game.providerGameId === live.providerGameId,
    );
    expect(row).toMatchObject({
      kind: 'game',
      game: {
        status: 'live',
        result: null,
        teamScore: snapshot.liveGame?.teamScore,
        opponentScore: snapshot.liveGame?.opponentScore,
      },
    });
    // The live part sets the schedule's lifetime too: 25 s, not 15 minutes.
    expect(schedule.body.schedule.freshness.ttlSeconds).toBe(25);
  });

  it('answers a failed prediction with a 200 and an error, never with a number (§12)', async () => {
    stubWith();
    const game = generateSeason(season, Date.now()).find((g) => g.status === 'scheduled')!;
    const env = testEnv({ SPORTS_PROVIDER_FAULT: 'prediction' });

    const { response, body } = await get<PredictionResponse>(
      `/api/games/${game.providerGameId}/prediction`,
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.prediction).toMatchObject({ data: null, error: { kind: 'provider_unavailable' } });

    // The rest of the page is unaffected (§42).
    const detail = await get<TeamDetailResponse>(
      `/api/teams/${teamUuid(game.home.team.providerTeamId)}`,
      env,
    );
    expect(detail.body.snapshot.data).not.toBeNull();
  });
});

describe('the offseason: SEASON_OVERRIDE=<year>:postseason (§22)', () => {
  const env = (): Env => testEnv({ SEASON_OVERRIDE: '2026:postseason' });

  it('a board of six finished seasons: records kept, nothing next, nothing live', async () => {
    stubWith();
    const { response, body } = await get<BoardResponse>(`/api/users/${WILSON_ID}/board`, env());
    expect(response.status).toBe(200);
    expect(body.season).toEqual({ year: 2026, type: 'postseason', week: null });
    expect(body.anyLive).toBe(false);
    expect(body.teams).toHaveLength(6);
    for (const { snapshot } of body.teams) {
      expect(snapshot.error).toBeNull();
      expect(snapshot.data).toMatchObject({
        nextGame: { kind: 'none', reason: 'season_complete' },
        liveGame: null,
        liveUpdatedAt: null,
        previousGame: { status: 'final' },
      });
      expect(snapshot.data?.record?.summary).toMatch(/^\d+-\d+$/);
    }
  });

  it('the final schedule stays whole: every game played or canceled, byes as rows', async () => {
    stubWith();
    const { body } = await get<TeamScheduleResponse>(
      `/api/teams/${teamUuid('333')}/schedule`,
      env(),
    );
    const items = body.schedule.data!.items;
    const games = items.flatMap((item) => (item.kind === 'game' ? [item.game] : []));
    expect(games.length).toBeGreaterThanOrEqual(8);
    expect(games.every((game) => game.status === 'final' || game.status === 'canceled')).toBe(true);
    expect(games.every((game) => (game.status === 'final') === (game.result !== null))).toBe(true);
    expect(items.some((item) => item.kind === 'bye')).toBe(true);
  });

  it('the last game’s prediction is still answered, which is why the page never asks', async () => {
    // The page targets only a live or upcoming game (web `predictionTarget`),
    // so a pregame number never appears beside a final score. The API itself
    // passes through what the provider says, as ESPN's core endpoint does.
    stubWith();
    const { body } = await get<TeamDetailResponse>(`/api/teams/${teamUuid('333')}`, env());
    expect(body.snapshot.data?.nextGame).toEqual({ kind: 'none', reason: 'season_complete' });
    const last = body.snapshot.data!.previousGame!;
    const prediction = await get<PredictionResponse>(
      `/api/games/${last.providerGameId}/prediction`,
      env(),
    );
    expect(prediction.response.status).toBe(200);
  });
});

// ─── Admin search, health, meta ──────────────────────────────────────────────

describe('GET /api/admin/teams/search (§43)', () => {
  const token = (): Promise<string> =>
    signToken(signingKey, {
      sub: 'admin-1',
      iss: TEST_ISSUER,
      aud: 'authenticated',
      exp: nowSeconds() + 3600,
    });

  it('requires an administrator: 401 without a token, 403 for anyone else', async () => {
    stubWith({ jwks: true, isAdmin: false });
    expect((await app.request('/api/admin/teams/search?q=texas', {}, testEnv())).status).toBe(401);
    const stranger = await app.request(
      '/api/admin/teams/search?q=texas',
      { headers: { Authorization: `Bearer ${await token()}` } },
      testEnv(),
    );
    expect(stranger.status).toBe(403);
  });

  it('finds teams, best match first, accent- and case-insensitively', async () => {
    stubWith({ jwks: true, isAdmin: true });
    const { response, body } = await get<TeamSearchResponse>(
      '/api/admin/teams/search?q=TEXAS',
      testEnv(),
      {
        Authorization: `Bearer ${await token()}`,
      },
    );
    expect(response.status).toBe(200);
    expect(body.teams[0]?.displayName).toBe('Texas');
    expect(body.teams.map((team) => team.abbreviation)).toEqual(
      expect.arrayContaining(['TA&M', 'TTU']),
    );
  });

  it('400s a query too short to be useful', async () => {
    stubWith({ jwks: true, isAdmin: true });
    const { response } = await get<ApiErrorBody>('/api/admin/teams/search?q=a', testEnv(), {
      Authorization: `Bearer ${await token()}`,
    });
    expect(response.status).toBe(400);
  });
});

// ─── A public search endpoint (plan-search-engine, Phase 2) ──────────────────

describe('GET /api/search/teams', () => {
  const espnEnv = (overrides: Partial<Env> = {}): Env =>
    testEnv({ SPORTS_PROVIDER: 'espn', ...overrides });

  const adminToken = (): Promise<string> =>
    signToken(signingKey, {
      sub: 'admin-1',
      iss: TEST_ISSUER,
      aud: 'authenticated',
      exp: nowSeconds() + 3600,
    });

  it('answers anyone, with no token and no JWT work at all (§11.1)', async () => {
    stubWith({ jwks: true });
    const { response, body } = await get<TeamSearchResponse>('/api/search/teams?q=tex');

    expect(response.status).toBe(200);
    expect(body.teams.map((team) => team.displayName)).toContain('Texas');
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    // Outside the admin branch: no key set was fetched and no token parsed.
    expect(stub.jwksFetches).toBe(0);
  });

  it('is cacheable for five minutes, so backtracking over a prefix is free', async () => {
    stubWith();
    const { response } = await get<TeamSearchResponse>('/api/search/teams?q=tex');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('reads no database at all — searching cannot create a `teams` row (§30, §31)', async () => {
    stub = installSupabaseStub({
      appUsers: [],
      teams: [],
      external: (url) => espnResponse(url, {}),
    });
    const { response, body } = await get<TeamSearchResponse>('/api/search/teams?q=alabama');

    // The positive half matters: with no 200 and no named team, "zero requests"
    // would also be true of a route that had simply fallen over.
    expect(response.status).toBe(200);
    expect(body.teams[0]?.providerTeamId).toBe('333');
    expect(stub.restRequests).toHaveLength(0);
    expect(stub.jwksFetches).toBe(0);
  });

  it('ranks identically to the admin route: one implementation, two doors', async () => {
    stubWith({ jwks: true, isAdmin: true });
    const open = await get<TeamSearchResponse>('/api/search/teams?q=TEXAS');
    const console_ = await get<TeamSearchResponse>('/api/admin/teams/search?q=TEXAS', testEnv(), {
      Authorization: `Bearer ${await adminToken()}`,
    });

    expect(open.body.teams[0]?.displayName).toBe('Texas');
    expect(open.body).toEqual(console_.body);
    // The whole difference between them, in one pair of headers.
    expect(open.response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(console_.response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('folds accents and case: "san jose" finds San José State', async () => {
    stubWith();
    const { body } = await get<TeamSearchResponse>('/api/search/teams?q=san%20jose', espnEnv());
    expect(body.teams.map((team) => team.name)).toContain('San José State Spartans');
  });

  it('caps the answer at twenty, whatever the caller asks for', async () => {
    // SEARCH_LIMIT is the abuse ceiling, which is why there is no `limit`
    // parameter to raise. 116 of the 762 teams match "state".
    stubWith();
    const { body } = await get<TeamSearchResponse>('/api/search/teams?q=state', espnEnv());
    expect(body.teams).toHaveLength(SEARCH_LIMIT);

    const asked = await get<TeamSearchResponse>('/api/search/teams?q=state&limit=500', espnEnv());
    expect(asked.body.teams).toHaveLength(SEARCH_LIMIT);
  });

  it('400s a missing query, one too short, and one too long', async () => {
    stubWith();
    const paths = [
      '/api/search/teams',
      '/api/search/teams?q=a',
      `/api/search/teams?q=${'a'.repeat(SEARCH_MAX_LENGTH + 1)}`,
    ];
    for (const path of paths) {
      const { response, body } = await get<ApiErrorBody>(path);
      expect(response.status, path).toBe(400);
      expect(body.error.kind, path).toBe('invalid_request');
    }
  });

  it('is a clean 503 with a reference number when the team list cannot be read', async () => {
    stubWith();
    const { response, body } = await get<ApiErrorBody>(
      '/api/search/teams?q=texas',
      testEnv({ SPORTS_PROVIDER_FAULT: 'teams' }),
    );
    expect(response.status).toBe(503);
    expect(body.error.kind).toBe('provider_unavailable');
    expect(body.error.requestId).toBe(response.headers.get('X-Request-Id'));
    expect(body.error.message).toBe('Team information is temporarily unavailable.');
  });

  it('never lets a failure inherit the five-minute lifetime', async () => {
    // `Cache-Control` is set after the await. Set before it, Hono would merge
    // it into the error handler's response too, and a browser would hold on to
    // a 503 for five minutes after the outage ended.
    stubWith();
    const short = await get<ApiErrorBody>('/api/search/teams?q=a');
    const down = await get<ApiErrorBody>(
      '/api/search/teams?q=texas',
      testEnv({ SPORTS_PROVIDER_FAULT: 'teams' }),
    );

    expect(short.response.status).toBe(400);
    expect(down.response.status).toBe(503);
    for (const response of [short.response, down.response]) {
      expect(response.headers.get('Cache-Control') ?? 'unset').not.toMatch(/max-age/);
    }
  });

  it('ESPN: each result carries its conference and a sized logo', async () => {
    stubWith();
    const { body } = await get<TeamSearchResponse>('/api/search/teams?q=alabama', espnEnv());
    expect(body.teams[0]).toMatchObject({
      providerTeamId: '333',
      name: 'Alabama Crimson Tide',
      conference: 'SEC',
      logoUrl: 'https://a.espncdn.com/combiner/i?img=/i/teamlogos/ncaa/500/333.png&w=144&h=144',
    });
  });

  it('ESPN: with the conference map down it degrades, never fails', async () => {
    // Its own test, not a second half of the one above: the tiers are reset per
    // test, and a warm conference map would hide the fault entirely.
    stubWith();
    const { response, body } = await get<TeamSearchResponse>(
      '/api/search/teams?q=alabama',
      espnEnv({ SPORTS_PROVIDER_FAULT: 'conferences' }),
    );
    expect(response.status).toBe(200);
    expect(body.teams[0]).toMatchObject({ providerTeamId: '333', conference: null });
  });

  it('spends no more of the KV budget the more it is searched', async () => {
    // A keystroke-driven endpoint against ~1,000 KV writes a day (plan §7).
    // Every query reads one list and one conference map, both written at most
    // daily, so the tenth search costs nothing the first did not.
    stubWith();
    const kv = new FakeKv();
    const env = espnEnv({ SPORTS_KV: kv.asNamespace() });
    for (const q of ['al', 'ala', 'alab', 'alaba', 'alabam', 'alabama']) {
      expect((await get(`/api/search/teams?q=${q}`, env)).response.status).toBe(200);
    }

    const categories = kv.writes.map((write) => write.key.split('|')[2]);
    expect(categories.sort()).toEqual(['conferences', 'season_calendar', 'team_list']);
  });
});

// ─── The pick index (plan-search-engine, Part Two, Phase 5) ──────────────────

describe('GET /api/selections', () => {
  /** The two seeded boards, inverted: Alabama (333) and Texas (251) are on both. */
  const bothBoards = () =>
    ownerRows([
      { user: WILSON, teams: WILSON_TEAMS },
      { user: JORDAN, teams: JORDAN_TEAMS },
    ]);

  const stubOwners = (selections: unknown[], options: { jwks?: boolean } = {}) => {
    stub = installSupabaseStub({
      appUsers: [WILSON, JORDAN],
      teams: ALL_TEAM_ROWS,
      selections,
      external: (url) => espnResponse(url, {}),
      ...(options.jwks === true ? { jwks: { keys: [signingKey.jwk] } } : {}),
    });
    return stub;
  };

  it('answers anyone with one anonymous Postgres read and no JWT work (§11.1)', async () => {
    stubOwners(bothBoards(), { jwks: true });
    const { response, body } = await get<TeamOwnersResponse>('/api/selections');

    // The positive half first: "one request" and "no key set" are both true of
    // a route that has simply fallen over.
    expect(response.status).toBe(200);
    expect(body.owners['333']?.map((owner) => owner.displayName)).toEqual(['Jordan', 'Wilson']);

    expect(stub.restRequests).toHaveLength(1);
    expect(stub.restRequests[0]?.authorization).toBeNull();
    expect(stub.restRequests[0]?.path).toContain('/rest/v1/user_team_selections');
    expect(stub.jwksFetches).toBe(0);
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('is cacheable for five minutes, the same lifetime the boards themselves have', async () => {
    stubOwners(bothBoards());
    const { response } = await get<TeamOwnersResponse>('/api/selections');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

  it('calls the provider not at all, and answers with the provider down', async () => {
    // App-owned data (§45). A team list outage takes out search and every team
    // page; it must not take out the question "who has this team".
    stubOwners(bothBoards());
    const { response, body } = await get<TeamOwnersResponse>(
      '/api/selections',
      testEnv({ SPORTS_PROVIDER: 'espn', SPORTS_PROVIDER_FAULT: 'teams' }),
    );

    expect(response.status).toBe(200);
    expect(Object.keys(body.owners)).toHaveLength(10);
    expect(stub.espnRequests).toHaveLength(0);
  });

  it('lists a shared team alphabetically, and leaves an unpicked team out entirely', async () => {
    stubOwners(bothBoards());
    const { body } = await get<TeamOwnersResponse>('/api/selections');

    // Alabama is on both boards; Jordan sorts before Wilson whatever order the
    // rows arrived in (Wilson's board is read first).
    expect(body.owners['333']).toEqual([
      { userId: JORDAN_ID, displayName: 'Jordan' },
      { userId: WILSON_ID, displayName: 'Wilson' },
    ]);
    // Georgia is Wilson's alone.
    expect(body.owners['61']).toEqual([{ userId: WILSON_ID, displayName: 'Wilson' }]);
    // Oregon is on neither board: absent, not an empty array. Most of the ~762
    // teams are in this state, and "Nobody has this team" on every row is noise.
    expect(body.owners['2483']).toBeUndefined();
    expect('2483' in body.owners).toBe(false);
  });

  it('answers an empty database with an empty index at 200, not a 404', async () => {
    stubOwners([]);
    const { response, body } = await get<TeamOwnersResponse>('/api/selections');
    expect(response.status).toBe(200);
    expect(body).toEqual({ owners: {} });
  });

  it('drops a foreign namespace and a broken embed, and keeps the rest', async () => {
    stubOwners([
      ownerRow(WILSON, '333'),
      // A `teams` row stored under another provider's ids: its id does not
      // compare with the provider ids this map is keyed by (§43).
      ownerRow(JORDAN, '333', 'mock'),
      // Impossible under `on delete restrict` / `on delete cascade`, but half
      // an owner is worse than none (the `toSelections` rule).
      { app_users: null, teams: { provider: 'espn', provider_team_id: '61' } },
      { app_users: { id: WILSON_ID, display_name: 'Wilson' }, teams: null },
    ]);
    const { response, body } = await get<TeamOwnersResponse>('/api/selections');

    expect(response.status).toBe(200);
    expect(body.owners).toEqual({ '333': [{ userId: WILSON_ID, displayName: 'Wilson' }] });
  });

  it('is a clean 5xx with a reference number, and no cache lifetime, when Postgres fails', async () => {
    stub = installSupabaseStub({ restFailure: 500 });
    const { response, body } = await get<ApiErrorBody>('/api/selections');

    expect(response.status).toBe(500);
    expect(body.error.kind).toBe('internal');
    expect(body.error.requestId).toBe(response.headers.get('X-Request-Id'));
    // The header is set after the await. Set before it, Hono would merge it
    // into the error handler's response and pin this failure in every browser
    // for five minutes (the Phase 2 finding, in a second place).
    expect(response.headers.get('Cache-Control') ?? 'unset').not.toMatch(/max-age/);
  });

  it('says plainly that the database is not configured, and still does not cache it', async () => {
    stubOwners(bothBoards());
    const { response, body } = await get<ApiErrorBody>(
      '/api/selections',
      testEnv({ SUPABASE_URL: '', SUPABASE_ANON_KEY: '' }),
    );

    expect(response.status).toBe(500);
    expect(body.error.message).toBe('The application database is not configured.');
    expect(response.headers.get('Cache-Control') ?? 'unset').not.toMatch(/max-age/);
    expect(stub.requests).toHaveLength(0);
  });

  it('spends no KV budget: this feature makes no provider call', async () => {
    stubOwners(bothBoards());
    const kv = new FakeKv();
    const env = testEnv({ SPORTS_PROVIDER: 'espn', SPORTS_KV: kv.asNamespace() });
    for (let i = 0; i < 3; i += 1) {
      expect((await get('/api/selections', env)).response.status).toBe(200);
    }
    expect(kv.writes).toHaveLength(0);
  });
});

describe('health and season metadata', () => {
  it('health reports the real L2 probe and the KV ledger, and calls no one', async () => {
    stubWith();
    const { body } = await get<HealthResponse>('/api/health', testEnv({ SPORTS_PROVIDER: 'espn' }));
    expect(body.cache.l2Available).toBe(false); // Node has no Cache API; neither does workers.dev, in effect
    expect(body.cache.kvWrites).toMatchObject({ total: 0, refused: 0 });
    expect(body.seasonSource).toBe('date');
    expect(stub.requests).toHaveLength(0);
  });

  it('health picks up the provider calendar once something has cached it', async () => {
    stubWith();
    await get(`/api/users/${WILSON_ID}/board`);
    const { body } = await get<HealthResponse>('/api/health');
    expect(body.seasonSource).toBe('provider');
    expect(body.season.week).toBe(6);
  });

  it('meta/season carries the calendar read’s own freshness', async () => {
    stubWith();
    const first = await get<SeasonMetaResponse>('/api/meta/season');
    expect(first.body.source).toBe('provider');
    expect(first.body.season.freshness.state).toBe('fresh');
    advanceMinutes(5);
    const second = await get<SeasonMetaResponse>('/api/meta/season');
    expect(second.body.season.freshness.state).toBe('cached');
    expect(second.body.season.freshness.fetchedAt).toBe(first.body.season.freshness.fetchedAt);
  });
});
