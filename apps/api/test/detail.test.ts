import type {
  ApiErrorBody,
  GameDetail,
  GameDetailResponse,
  HealthResponse,
  MatchupBoardResponse,
  MatchupResponse,
  PredictionResponse,
} from '@cfb/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { policyFor } from '../src/cache/policy';
import { resetInflight } from '../src/cache/swr';
import { resetCacheTiers } from '../src/cache/tiers';
import type { Env } from '../src/env';
import { resetRateLimits } from '../src/middleware/rate-limit';
import { toGameDetail, toProviderGame } from '../src/providers/espn/normalize';
import { readGameDetail, readSchedule, readScoreboard } from '../src/providers/espn/validate';
import { MOCK_WIN_PROBABILITY_LABEL } from '../src/providers/mock/detail';
import { generateSeason } from '../src/providers/mock/generate';
import type { ProviderGame } from '../src/providers/types';
import { detailState } from '../src/services/games';
import { JORDAN, WILSON } from './helpers/boards';
import { espnResponse, type EspnStubOptions } from './helpers/espn-stub';
import { fixture } from './helpers/fixtures';
import { FakeKv } from './helpers/kv';
import { installSupabaseStub, testEnv, type SupabaseStub } from './helpers/supabase-stub';

/**
 * Inside the game (context/plan-matchup-board.md, Phase 3): the summary's box
 * score, leaders, line score, scoring plays, drive, and in-game win
 * probability, normalized inside `providers/espn/` and served as
 * `GET /api/games/:gameId/detail`; and down and distance, from the live slate,
 * on the matchup row.
 *
 * The real-payload half runs captures taken DURING the games of 2026-10-03:
 * the week-5 document with two live matchups in it, the day's slate seconds
 * later, and California at UNLV's summary in the fourth quarter.
 */

const MOCK_NOW = '2026-10-07T18:00:00Z'; // a Wednesday in mock week 6
/** The moment the live captures were taken. */
const LIVE_CAPTURED_AT = '2026-10-03T23:07:50Z';
const CAL_AT_UNLV = '401858247';
const MIAMI_AT_CLEMSON = '401858249';

const app = createApp();
let stub: SupabaseStub | undefined;

beforeEach(() => {
  resetCacheTiers();
  resetInflight();
  resetRateLimits();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(MOCK_NOW));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const advanceSeconds = (seconds: number): void => {
  vi.setSystemTime(new Date(Date.now() + seconds * 1000));
};

async function get<T>(path: string, env: Env = testEnv(), headers: Record<string, string> = {}) {
  const response = await app.request(path, { headers }, env);
  return { response, body: (await response.json()) as T };
}

function install(espn: EspnStubOptions = {}) {
  stub = installSupabaseStub({
    appUsers: [WILSON, JORDAN],
    external: (url) => espnResponse(url, espn),
  });
  return stub;
}

function detailOf(name: string): GameDetail {
  const raw = readGameDetail(fixture(name));
  if (raw === null) throw new Error(`${name} did not read`);
  return toGameDetail(raw);
}

/** Every string leaf under a JSON value, for "nothing from here leaked" checks. */
function leaves(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string' && value.trim().length > 3) into.add(value);
  else if (Array.isArray(value)) value.forEach((entry) => leaves(entry, into));
  else if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach((entry) => leaves(entry, into));
  }
  return into;
}

// ─── The ESPN half: normalization of real captures ───────────────────────────

describe('ESPN: inside a live game (California at UNLV, 4th quarter)', () => {
  const detail = detailOf('game-live-matchup');

  it('reads the line score per quarter, with the provider’s own totals', () => {
    expect(detail.status).toBe('live');
    expect(detail.lineScore?.periods.map((period) => period.label)).toEqual(['1', '2', '3', '4']);
    expect(detail.lineScore).toMatchObject({ homeTotal: 32, awayTotal: 25 });
    // The quarters add up to the totals ESPN sent; nothing was summed to make them.
    const sum = (side: 'home' | 'away'): number =>
      (detail.lineScore?.periods ?? []).reduce((total, period) => total + (period[side] ?? 0), 0);
    expect([sum('home'), sum('away')]).toEqual([32, 25]);
  });

  it('reads game stats by name, as display strings, with a number only where one was sent', () => {
    expect(detail.statsKind).toBe('game');
    expect(detail.teamStats.map((row) => row.key)).toContain('thirdDownEff');
    const third = detail.teamStats.find((row) => row.key === 'thirdDownEff');
    expect(third).toMatchObject({ label: '3rd down efficiency', home: { display: '4-14' } });
    // ESPN's `value` for total yards is the string "-": no number, never NaN.
    const total = detail.teamStats.find((row) => row.key === 'totalYards');
    expect(total?.home).toEqual({ display: '320', value: null });
    // A padded clock is trimmed and otherwise verbatim.
    const possession = detail.teamStats.find((row) => row.key === 'possessionTime');
    expect(possession?.home.display).toMatch(/^\d{1,2}:\d{2}$/);
    expect(JSON.stringify(detail)).not.toMatch(/NaN|undefined/);
  });

  it('a reordered statistics array reads the same: by name, never by position', () => {
    const body = fixture('game-live-matchup') as {
      boxscore: { teams: { statistics: unknown[] }[] };
    };
    for (const team of body.boxscore.teams) team.statistics.reverse();
    const raw = readGameDetail(body);
    expect(raw && toGameDetail(raw).teamStats).toEqual(detail.teamStats);
  });

  it('reads leaders for both sides, verbatim', () => {
    expect(detail.leaders.map((row) => row.category)).toEqual(['passing', 'rushing', 'receiving']);
    expect(detail.leaders[0]?.home).toEqual({
      name: 'Jackson Arnold',
      line: '11/22, 177 YDS, 3 TD',
    });
  });

  it('reads scoring plays in game order, each with the score after it', () => {
    expect(detail.scoringPlays).toHaveLength(9);
    expect(detail.scoringPlays.at(-1)).toMatchObject({
      period: 4,
      kind: 'TD',
      teamId: '2439',
      homeScore: 32,
      awayScore: 25,
    });
  });

  it('reads the current drive and ESPN’s in-game win probability as 0–1, labelled ESPN', () => {
    expect(detail.currentDrive).toEqual({ teamId: '25', description: '4 plays, 5 yards, 1:41' });
    const wp = detail.winProbability;
    expect(wp?.source).toBe('espn_win_probability');
    expect(wp?.sourceLabel).toBe('ESPN win probability');
    expect(wp?.homeWinProbability).toBe(0.9229);
    expect(wp?.awayWinProbability).toBeCloseTo(0.0771, 4);
    expect(wp?.homeSeries).toHaveLength(167);
    for (const value of wp?.homeSeries ?? []) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('a series on a 0–100 scale is divided in normalization, never later', () => {
    const body = fixture('game-live-matchup') as {
      winprobability: { homeWinPercentage: number }[];
    };
    for (const point of body.winprobability) point.homeWinPercentage *= 100;
    const raw = readGameDetail(body);
    const wp = raw && toGameDetail(raw).winProbability;
    expect(wp?.homeWinProbability).toBe(0.9229);
    expect(Math.max(...(wp?.homeSeries ?? []))).toBeLessThanOrEqual(1);
  });

  it('carries nothing from the betting keys beside the box score (§46)', () => {
    const body = fixture('game-live-matchup') as Record<string, unknown>;
    const bettingKeys = ['odds', 'pickcenter', 'againstTheSpread'];
    // Strings found ONLY under the betting keys: team ids and names are shared
    // with the header and are not betting data.
    const elsewhere = leaves(
      Object.entries(body)
        .filter(([key]) => !bettingKeys.includes(key))
        .map(([, value]) => value),
    );
    const betting = new Set(
      [...leaves(bettingKeys.map((key) => body[key]))].filter((text) => !elsewhere.has(text)),
    );
    expect(betting.size).toBeGreaterThan(0);
    // Our own vocabulary (`statsKind: 'game'`, a category name) is not ESPN's text.
    const ours = new Set([
      detail.status,
      detail.statsKind,
      ...detail.leaders.flatMap((row) => [row.category, row.label]),
      detail.winProbability?.source ?? '',
    ]);
    const normalized = new Set([...leaves(detail)].filter((text) => !ours.has(text)));
    for (const text of betting) expect(normalized.has(text), text).toBe(false);
    expect(JSON.stringify(detail)).not.toMatch(/spread|moneyline|overUnder|pickcenter|odds/i);
  });
});

describe('ESPN: before kickoff, a final, and a postponement', () => {
  it('before kickoff the box score is season averages, never in a game column', () => {
    const detail = detailOf('game-upcoming-matchup');
    expect(detail.status).toBe('scheduled');
    expect(detail.statsKind).toBe('season_average');
    const keys = detail.teamStats.map((row) => row.key);
    expect(keys).toContain('totalPointsPerGame');
    expect(keys).not.toContain('firstDowns');
    expect(detail.lineScore).toBeNull();
    expect(detail.scoringPlays).toEqual([]);
    expect(detail.currentDrive).toBeNull();
    expect(detail.winProbability).toBeNull();
    // Season leaders, labelled by `statsKind`: Miami's quarterback, season to date.
    expect(detail.leaders[0]?.away?.name).toBe('Darian Mensah');
  });

  it('a final game has stats and scoring plays, and no win probability although ESPN sends 177 points', () => {
    expect((fixture('game-final') as { winprobability: unknown[] }).winprobability).toHaveLength(
      177,
    );
    const detail = detailOf('game-final');
    expect(detail.status).toBe('final');
    expect(detail.winProbability).toBeNull();
    expect(detail.currentDrive).toBeNull();
    expect(detail.scoringPlays).toHaveLength(8);
    expect(detail.lineScore).toMatchObject({ homeTotal: 27, awayTotal: 13 });
  });

  it('a postponed game publishes nothing, and says so with empty lists, never zeros', () => {
    const detail = detailOf('game-postponed');
    expect(detail).toMatchObject({
      status: 'postponed',
      lineScore: null,
      teamStats: [],
      leaders: [],
      scoringPlays: [],
      winProbability: null,
    });
  });
});

describe('ESPN: down and distance come from the slate, and only the slate', () => {
  it('a live slate game carries possession, down and distance, and the last play', () => {
    const slate = readScoreboard(fixture('scoreboard-20261003-live'));
    const game = slate?.events
      .map((event) => toProviderGame(event))
      .find((entry) => entry.providerGameId === CAL_AT_UNLV);
    expect(game?.situation).toMatchObject({
      possessionTeamId: '2439',
      downDistance: '1st & 10 at UNLV 48',
    });
    expect(game?.situation?.lastPlay).toContain('TURNOVER ON DOWNS');
  });

  it('a final row and a schedule carry none', () => {
    const slate = readScoreboard(fixture('scoreboard-20261003-live'));
    const finals = (slate?.events ?? [])
      .map((event) => toProviderGame(event))
      .filter((game) => game.status === 'final');
    expect(finals.length).toBeGreaterThan(0);
    expect(finals.every((game) => game.situation === undefined)).toBe(true);
    const schedule = readSchedule(fixture('schedule-ranked'));
    expect(schedule?.events.every((event) => toProviderGame(event).situation === undefined)).toBe(
      true,
    );
  });
});

// ─── The cache lifetime ──────────────────────────────────────────────────────

describe('a detail is cached by the state of its game', () => {
  const base = detailOf('game-upcoming-matchup');
  const kickoff = Date.parse(base.kickoffUtc);

  it('live: 25 s, L1 only; final: a week; upcoming: 10 minutes, KV at most hourly', () => {
    expect(policyFor('game_detail', { detailState: 'live' })).toMatchObject({
      ttlSeconds: 25,
      tiers: ['l1'],
      category: 'game_detail',
    });
    expect(policyFor('game_detail', { detailState: 'final' }).ttlSeconds).toBe(7 * 24 * 3600);
    expect(policyFor('game_detail', { detailState: 'upcoming' })).toMatchObject({
      ttlSeconds: 600,
      kvWriteIntervalSeconds: 3600,
    });
  });

  it('a scheduled game is treated as live from fifteen minutes before kickoff', () => {
    expect(detailState(base, kickoff - 16 * 60_000)).toBe('upcoming');
    expect(detailState(base, kickoff - 14 * 60_000)).toBe('live');
    expect(detailState({ ...base, kickoffTbd: true }, kickoff)).toBe('upcoming');
    expect(detailState({ ...base, status: 'final' }, kickoff)).toBe('final');
    expect(detailState({ ...base, status: 'postponed' }, kickoff)).toBe('upcoming');
  });
});

// ─── The route, in mock mode ─────────────────────────────────────────────────

/** The mock's current week, as the provider generates it: one game in each state. */
async function mockGames() {
  const games = generateSeason({ year: 2026, type: 'regular', week: 6 }, Date.now()).filter(
    (game) => game.week === 6,
  );
  const pick = (test: (game: ProviderGame) => boolean) => {
    const game = games.find(test);
    if (game === undefined) throw new Error('no such mock game this week');
    return game;
  };
  return Promise.resolve({
    live: pick((game) => game.status === 'live'),
    final: pick((game) => game.status === 'final'),
    upcoming: pick((game) => game.status === 'scheduled' && !game.kickoffTbd),
    postponed: pick((game) => game.status === 'postponed'),
  });
}

describe('GET /api/games/:gameId/detail (mock)', () => {
  it('a live game: everything, labelled mock, and the line score sums to the header’s score', async () => {
    install();
    const { live } = await mockGames();
    const { response, body } = await get<GameDetailResponse>(
      `/api/games/${live.providerGameId}/detail`,
    );
    expect(response.status).toBe(200);
    const detail = body.detail.data;
    expect(body.detail.freshness.provider).toBe('mock');
    expect(detail?.statsKind).toBe('game');
    expect(detail?.winProbability?.sourceLabel).toBe(MOCK_WIN_PROBABILITY_LABEL);
    expect(detail?.currentDrive).not.toBeNull();
    const sum = (side: 'home' | 'away'): number =>
      (detail?.lineScore?.periods ?? []).reduce((total, period) => total + (period[side] ?? 0), 0);
    expect(sum('home')).toBe(live.home.score);
    expect(sum('away')).toBe(live.away.score);
    expect(detail?.lineScore?.homeTotal).toBe(live.home.score);
    // Every scoring play's running score ends at the header's score.
    const last = detail?.scoringPlays.at(-1);
    if (last !== undefined)
      expect([last.homeScore, last.awayScore]).toEqual([live.home.score, live.away.score]);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=25');
  });

  it('a live game moves across polls: stats, line score, and probability, each newly dated', async () => {
    install();
    const { live } = await mockGames();
    const path = `/api/games/${live.providerGameId}/detail`;
    const first = (await get<GameDetailResponse>(path)).body.detail;
    advanceSeconds(10 * 60);
    const later = (await get<GameDetailResponse>(path)).body.detail;
    expect(later.freshness.fetchedAt).not.toBe(first.freshness.fetchedAt);
    expect(later.data?.teamStats).not.toEqual(first.data?.teamStats);
    expect(later.data?.winProbability?.homeSeries.length).toBeGreaterThan(
      first.data?.winProbability?.homeSeries.length ?? 0,
    );
    expect(later.data?.status).toBe('live');
  });

  it('the matchup row carries down and distance from the slate, and it moves too', async () => {
    install();
    const { live } = await mockGames();
    const path = `/api/matchups/${live.providerGameId}`;
    const first = (await get<MatchupResponse>(path)).body.matchup;
    expect(first.situation?.downDistance).toMatch(/^(1st|2nd|3rd|4th) & \d+ at \S+ \d+$/);
    expect([first.home.team.providerTeamId, first.away.team.providerTeamId]).toContain(
      first.situation?.possessionTeamId,
    );
    advanceSeconds(5 * 60);
    const later = (await get<MatchupResponse>(path)).body.matchup;
    expect(later.situation).not.toEqual(first.situation);
  });

  it('only live rows carry a situation', async () => {
    install();
    const { body } = await get<MatchupBoardResponse>('/api/matchups');
    for (const row of body.matchups) {
      if (row.status === 'live') expect(row.situation, row.providerGameId).not.toBeNull();
      else expect(row.situation, row.providerGameId).toBeNull();
    }
  });

  it('a final game: stats and scoring plays, no win probability, cached for a week', async () => {
    install();
    const { final } = await mockGames();
    const { response, body } = await get<GameDetailResponse>(
      `/api/games/${final.providerGameId}/detail`,
    );
    const detail = body.detail.data;
    expect(detail?.status).toBe('final');
    expect(detail?.winProbability).toBeNull();
    expect(detail?.currentDrive).toBeNull();
    expect(detail?.scoringPlays.length).toBeGreaterThan(0);
    expect(detail?.teamStats.length).toBeGreaterThan(0);
    expect(response.headers.get('Cache-Control')).toBe(`public, max-age=${String(7 * 24 * 3600)}`);
  });

  it('before kickoff: season averages and season leaders, nothing from a game that has not started', async () => {
    install();
    const { upcoming } = await mockGames();
    const detail = (await get<GameDetailResponse>(`/api/games/${upcoming.providerGameId}/detail`))
      .body.detail.data;
    expect(detail?.statsKind).toBe('season_average');
    expect(detail?.teamStats.map((row) => row.key)).toContain('totalPointsPerGame');
    expect(detail?.lineScore).toBeNull();
    expect(detail?.scoringPlays).toEqual([]);
    expect(detail?.winProbability).toBeNull();
  });

  it('a postponed game: nothing published, as empty lists', async () => {
    install();
    const { postponed } = await mockGames();
    const detail = (await get<GameDetailResponse>(`/api/games/${postponed.providerGameId}/detail`))
      .body.detail.data;
    expect(detail).toMatchObject({ teamStats: [], leaders: [], scoringPlays: [], lineScore: null });
  });

  it('an unknown game is a 404; a malformed id is a 404 before any read', async () => {
    const recorded = install();
    expect((await get<ApiErrorBody>('/api/games/99999999999999/detail')).response.status).toBe(404);
    const before = recorded.requests.length;
    expect((await get<ApiErrorBody>('/api/games/not%20an%20id/detail')).response.status).toBe(404);
    expect(recorded.requests).toHaveLength(before);
  });
});

describe('the detail fails alone (§42)', () => {
  it('with `detail` faulted: an unavailable envelope with a logged reference; header and prediction stand', async () => {
    install();
    const { live } = await mockGames();
    const env = testEnv({ SPORTS_PROVIDER_FAULT: 'detail' });
    const { response, body } = await get<GameDetailResponse>(
      `/api/games/${live.providerGameId}/detail`,
      env,
      { 'x-request-id': 'req-detail' },
    );
    expect(response.status).toBe(200);
    expect(body.detail.data).toBeNull();
    expect(body.detail.freshness.state).toBe('unavailable');
    expect(body.detail.error?.requestId).toBe('req-detail');
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    // The reference leads to the log line the failure was written under.
    const logged = vi
      .mocked(console.warn)
      .mock.calls.map(
        ([line]) =>
          JSON.parse(String(line)) as { event?: string; requestId?: string; key?: string },
      )
      .filter((entry) => entry.event?.startsWith('cache_refresh_failed') === true);
    expect(
      logged.some(
        (entry) => entry.requestId === 'req-detail' && entry.key?.includes('|game_detail|'),
      ),
    ).toBe(true);

    const header = await get<MatchupResponse>(`/api/matchups/${live.providerGameId}`, env);
    expect(header.response.status).toBe(200);
    expect(header.body.matchup.status).toBe('live');
    const prediction = await get<PredictionResponse>(
      `/api/games/${live.providerGameId}/prediction`,
      env,
    );
    expect(prediction.response.status).toBe(200);
    expect(prediction.body.prediction.error).toBeNull();
  });

  it('a warm detail past its TTL is served stale with its original time', async () => {
    install();
    const { upcoming } = await mockGames();
    const path = `/api/games/${upcoming.providerGameId}/detail`;
    const warm = (await get<GameDetailResponse>(path)).body.detail;
    advanceSeconds(11 * 60);
    const { body } = await get<GameDetailResponse>(
      path,
      testEnv({ SPORTS_PROVIDER_FAULT: 'detail' }),
    );
    expect(body.detail.freshness).toMatchObject({
      state: 'stale',
      fetchedAt: warm.freshness.fetchedAt,
    });
    expect(body.detail.data?.statsKind).toBe('season_average');
  });

  it('with `slate` faulted, a live row is stale with its original time and shows no situation', async () => {
    install();
    const { live } = await mockGames();
    resetCacheTiers();
    resetInflight();
    const { body } = await get<MatchupResponse>(
      `/api/matchups/${live.providerGameId}`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'slate' }),
    );
    expect(body.matchup.freshness.state).toBe('stale');
    expect(body.matchup.situation).toBeNull();
  });
});

describe('the KV budget', () => {
  it('a live detail writes nothing; upcoming and final details write under game_detail', async () => {
    install();
    const kv = new FakeKv();
    const env = testEnv({ SPORTS_KV: kv.asNamespace() });
    const { live, final, upcoming } = await mockGames();
    for (let poll = 0; poll < 8; poll += 1) {
      await get<GameDetailResponse>(`/api/games/${live.providerGameId}/detail`, env);
      advanceSeconds(15);
    }
    expect(kv.writes.some((write) => write.key.includes('|game_detail|'))).toBe(false);

    await get<GameDetailResponse>(`/api/games/${final.providerGameId}/detail`, env);
    await get<GameDetailResponse>(`/api/games/${upcoming.providerGameId}/detail`, env);
    const health = (await get<HealthResponse>('/api/health', env)).body;
    expect(health.cache.kvWrites.byCategory['game_detail']).toBe(2);
  });
});

// ─── The real Saturday, through both routes ──────────────────────────────────

describe('the captured live Saturday, through both routes (ESPN)', () => {
  const live: EspnStubOptions = {
    weeks: { '2/5': 'scoreboard-week-5-live' },
    slates: { '20261003': 'scoreboard-20261003-live' },
    summaries: { [CAL_AT_UNLV]: 'game-live-matchup', [MIAMI_AT_CLEMSON]: 'game-upcoming-matchup' },
    // The live summary carries no inline predictor; the standalone one answers.
    predictors: [CAL_AT_UNLV],
  };
  const espnEnv = (): Env => testEnv({ SPORTS_PROVIDER: 'espn' });

  it('the header takes score, clock, and situation from the slate; the detail is ESPN’s, labelled', async () => {
    vi.setSystemTime(new Date(LIVE_CAPTURED_AT));
    install(live);
    const header = await get<MatchupResponse>(`/api/matchups/${CAL_AT_UNLV}`, espnEnv());
    expect(header.response.status).toBe(200);
    const row = header.body.matchup;
    expect(row.status).toBe('live');
    expect(row.statusDetail).toBe('7:39 - 4th Quarter');
    expect(row.situation).toMatchObject({
      possessionTeamId: '2439',
      downDistance: '1st & 10 at UNLV 48',
    });

    const detail = await get<GameDetailResponse>(`/api/games/${CAL_AT_UNLV}/detail`, espnEnv());
    expect(detail.response.status).toBe(200);
    expect(detail.body.detail.freshness.provider).toBe('espn');
    expect(detail.body.detail.data?.winProbability?.sourceLabel).toBe('ESPN win probability');
    expect(detail.response.headers.get('Cache-Control')).toBe('public, max-age=25');

    // The pregame predictor is still served during the game, under its own label.
    const prediction = await get<PredictionResponse>(
      `/api/games/${MIAMI_AT_CLEMSON}/prediction`,
      espnEnv(),
    );
    expect(prediction.body.prediction.data?.sourceLabel).toBe('ESPN Matchup Predictor');
  });

  /**
   * The three answers the game page reads, from the real captures, saved for
   * the web's real-payload test (apps/web/src/test/real-saturday.json), which
   * renders them and asserts the labels where they are seen. A snapshot, so
   * the web test can never drift from what these routes actually answer:
   * change the API and this fails until the file is regenerated (`-u`).
   */
  it('the page’s three answers, as the web test renders them', async () => {
    vi.setSystemTime(new Date(LIVE_CAPTURED_AT));
    install(live);
    const [matchup, detail, prediction] = await Promise.all([
      get<MatchupResponse>(`/api/matchups/${CAL_AT_UNLV}`, espnEnv()),
      get<GameDetailResponse>(`/api/games/${CAL_AT_UNLV}/detail`, espnEnv()),
      get<PredictionResponse>(`/api/games/${CAL_AT_UNLV}/prediction`, espnEnv()),
    ]);
    expect(prediction.body.prediction.data?.sourceLabel).toBe('ESPN Matchup Predictor');
    const saved = {
      _note:
        'Generated by apps/api/test/detail.test.ts from the captures of 2026-10-03T23:07Z (California at UNLV, 4th quarter). Do not edit by hand; rerun that test with -u.',
      matchup: matchup.body,
      detail: detail.body,
      prediction: prediction.body,
    };
    await expect(`${JSON.stringify(saved, null, 2)}
`).toMatchFileSnapshot('../../web/src/test/real-saturday.json');
  });

  it('the live week board: every in-progress matchup has a situation or says it has none', async () => {
    vi.setSystemTime(new Date(LIVE_CAPTURED_AT));
    install(live);
    const { body } = await get<MatchupBoardResponse>('/api/matchups?week=5', espnEnv());
    const cal = body.matchups.find((row) => row.providerGameId === CAL_AT_UNLV);
    // Nobody in the test boards has California or UNLV, so the board itself
    // need not list it; the single-game route above is what serves the page.
    expect(cal === undefined || cal.situation !== null).toBe(true);
    for (const row of body.matchups) {
      if (row.status !== 'live') expect(row.situation).toBeNull();
    }
  });
});
