import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ApiErrorBody,
  BoardResponse,
  HealthResponse,
  Matchup,
  MatchupBoardResponse,
  MatchupResponse,
  Season,
} from '@cfb/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { resetInflight } from '../src/cache/swr';
import { resetCacheTiers } from '../src/cache/tiers';
import type { Env } from '../src/env';
import { resetRateLimits } from '../src/middleware/rate-limit';
import { EspnClient } from '../src/providers/espn/client';
import { easternSlateKey, toSeasonWeeks, toTeamIdentity } from '../src/providers/espn/normalize';
import { EspnProvider } from '../src/providers/espn/provider';
import { readCalendarWeeks, readTeamList } from '../src/providers/espn/validate';
import { generateSeason } from '../src/providers/mock/generate';
import { ProviderError } from '../src/providers/types';
import { compareRows, defaultWeek, indexPicks } from '../src/services/matchups';
import { userRow, uuidFor } from './helpers/boards';
import { espnResponse, espnStub } from './helpers/espn-stub';
import { fixture } from './helpers/fixtures';
import { FakeKv } from './helpers/kv';
import { installSupabaseStub, testEnv, type SupabaseStub } from './helpers/supabase-stub';

/**
 * The matchup board, Phase 1 (context/plan-matchup-board.md): the week's
 * games in one provider read, joined to every board's picks, served as
 * `GET /api/matchups?week=` and `GET /api/matchups/:gameId`.
 *
 * Two kinds of evidence. The mock, against the repo's seed (nine boards, four
 * teams shared), for every state and every fault. And the REAL week documents
 * captured 2026-10-03, against the REAL pick index captured the same night,
 * for the counts the plan measured before any code existed: 11 matchups in
 * week 5 and 12 in week 6, one same-owner game in each, and none of the 22
 * one-sided games either week.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_NOW = '2026-10-07T18:00:00Z'; // a Wednesday in mock week 6
/** When the week documents and the pick index were captured: Friday night, week 5. */
const WEEK_CAPTURED_AT = '2026-10-03T03:26:00Z';

const app = createApp();
let stub: SupabaseStub | undefined;

beforeEach(() => {
  resetCacheTiers();
  resetInflight();
  resetRateLimits();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(MOCK_NOW));
  // Stale fallbacks and injected faults log by design.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const advanceMinutes = (minutes: number): void => {
  vi.setSystemTime(new Date(Date.now() + minutes * 60_000));
};

async function get<T>(path: string, env: Env = testEnv()) {
  const response = await app.request(path, {}, env);
  return { response, body: (await response.json()) as T };
}

// ─── The boards ──────────────────────────────────────────────────────────────

/**
 * The repo's seed, read from `supabase/seed.sql` itself so this cannot drift
 * from it: nine boards of six, Jordan sharing four teams with three others.
 */
function seedBoards(): Record<string, unknown>[] {
  const sql = readFileSync(join(HERE, '..', '..', '..', 'supabase', 'seed.sql'), 'utf8');
  const block = sql.slice(sql.indexOf('insert into public.user_team_selections'));
  const boards = new Map<string, string[]>();
  for (const [, name, team] of block.matchAll(/\('(\w+)',\s*'(\d+)',\s*\d+\)/g)) {
    boards.set(name!, [...(boards.get(name!) ?? []), team!]);
  }
  return [...boards].map(([name, teams], index) => userRow(index + 1, name, teams));
}

interface PickIndexFixture {
  owners: Record<string, { userId: string; displayName: string }[]>;
}

/**
 * The deployed Worker's `/api/selections`, captured the night the week
 * documents were, turned back into the rows `listBoardsWithSelections` reads.
 * Identity comes from the captured team list, as a stored `teams` row's would.
 */
function realBoards(): Record<string, unknown>[] {
  const index = JSON.parse(
    readFileSync(join(HERE, 'fixtures', 'app', 'pick-index.json'), 'utf8'),
  ) as PickIndexFixture;
  const identities = new Map(
    (readTeamList(fixture('team-list')) ?? []).map((raw) => {
      const team = toTeamIdentity(raw);
      return [team.providerTeamId, team];
    }),
  );
  const people = new Map<string, { name: string; teams: string[] }>();
  for (const [teamId, owners] of Object.entries(index.owners)) {
    for (const owner of owners) {
      const person = people.get(owner.userId) ?? { name: owner.displayName, teams: [] };
      person.teams.push(teamId);
      people.set(owner.userId, person);
    }
  }
  return [...people].map(([userId, { name, teams }]) => ({
    id: userId,
    display_name: name,
    user_team_selections: teams.map((teamId, order) => {
      const team = identities.get(teamId);
      if (team === undefined) throw new Error(`team ${teamId} is not in the team list`);
      return {
        id: uuidFor(70_000 + Number(teamId)),
        selection_order: order + 1,
        created_at: '2026-09-01T00:00:00Z',
        teams: {
          id: uuidFor(80_000 + Number(teamId)),
          provider: 'espn',
          provider_team_id: teamId,
          name: team.name,
          display_name: team.displayName,
          abbreviation: team.abbreviation,
          logo_url: team.logoUrl,
          conference: null,
          primary_color: team.primaryColor,
          alt_color: team.altColor,
        },
      };
    }),
  }));
}

function realPickIndex(): PickIndexFixture['owners'] {
  return (
    JSON.parse(
      readFileSync(join(HERE, 'fixtures', 'app', 'pick-index.json'), 'utf8'),
    ) as PickIndexFixture
  ).owners;
}

function install(users: Record<string, unknown>[] = seedBoards(), restFailure?: number) {
  stub = installSupabaseStub({
    appUsers: users,
    external: (url) => espnResponse(url),
    ...(restFailure === undefined ? {} : { restFailure }),
  });
  return stub;
}

const espnEnv = (overrides: Partial<Env> = {}): Env =>
  testEnv({ SPORTS_PROVIDER: 'espn', ...overrides });

// ─── What a row must always be ───────────────────────────────────────────────

function sectionOf(row: Matchup): number {
  if (row.status === 'live') return 0;
  if (row.status === 'final') return 2;
  if (row.status === 'postponed' || row.status === 'canceled') return 3;
  return 1;
}

/** Two owned sides, owners named and sorted, and §5's invariant on the verdict. */
function expectWellFormed(row: Matchup): void {
  for (const side of [row.home, row.away]) {
    expect(side.owners.length, row.providerGameId).toBeGreaterThan(0);
    for (const owner of side.owners) expect(owner.displayName.trim()).not.toBe('');
    const names = side.owners.map((owner) => owner.displayName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(side.team.id, 'identity from Postgres').toMatch(/^[0-9a-f-]{36}$/);
    if (row.status !== 'final') expect(side.winner).toBeNull();
    if (row.status !== 'final' && row.status !== 'live') expect(side.score).toBeNull();
  }
  const homeIds = new Set(row.home.owners.map((owner) => owner.userId));
  expect(row.sameOwner).toBe(row.away.owners.some((owner) => homeIds.has(owner.userId)));
}

// ─── The provider half ───────────────────────────────────────────────────────

describe('ESPN: a week of games is one request, through the existing scoreboard path', () => {
  const SEASON: Season = { year: 2026, type: 'regular', week: 5 };

  function provider(): { espn: EspnProvider; urls: string[] } {
    const fake = espnStub();
    return {
      espn: new EspnProvider(new EspnClient({ fetch: fake.fetch, sleep: async () => undefined })),
      urls: fake.urls,
    };
  }

  it('asks for the week, the season type, FBS, and room for every game', async () => {
    const { espn, urls } = provider();
    const games = await espn.getWeekGames(SEASON, 6);
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      week: '6',
      seasontype: '2',
      groups: '80',
      limit: '300',
    });
    // The plan's measurement, on the captured document: 58 games, five days.
    expect(games).toHaveLength(58);
    expect(games.every((game) => game.week === 6 && game.season.type === 'regular')).toBe(true);
  });

  it('reads the captured week documents with no new parser, live and final rows included', async () => {
    const { espn } = provider();
    const week5 = await espn.getWeekGames(SEASON, 5);
    expect(week5).toHaveLength(59);
    // Nebraska–Penn State was in the 4th quarter when week 5 was captured.
    const live = week5.find((game) => game.providerGameId === '401858476');
    expect(live).toMatchObject({ status: 'live', period: 4, clock: '4:38' });
    expect([live?.home.score, live?.away.score]).toEqual([31, 13]);
    expect(week5.filter((game) => game.status === 'final')).toHaveLength(4);
    // A normalized week is a small fraction of the payload it came from: that
    // is what the cache stores.
    const stored = JSON.stringify(week5).length;
    expect(stored).toBeLessThan(100_000);
  });

  it('takes home, away, and neutral from the provider, never from list order (§19)', async () => {
    const { espn } = provider();
    const week6 = await espn.getWeekGames(SEASON, 6);
    const redRiver = week6.find((game) => game.providerGameId === '401856717');
    expect(redRiver?.neutralSite).toBe(true);
    expect(week6.find((game) => game.providerGameId === '401858484')?.neutralSite).toBe(false);
    // Four TBD kickoffs, at ESPN's midnight-Eastern placeholder.
    expect(week6.filter((game) => game.kickoffTbd)).toHaveLength(4);
  });

  it('refuses a payload for a different week than the one asked for', async () => {
    const fake = espnStub({ weeks: { '2/7': 'scoreboard-week-6' } });
    const espn = new EspnProvider(
      new EspnClient({ fetch: fake.fetch, sleep: async () => undefined }),
    );
    await expect(espn.getWeekGames(SEASON, 7)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('refuses a week number nothing could be, before any request', async () => {
    const { espn, urls } = provider();
    await expect(espn.getWeekGames(SEASON, 1000)).rejects.toBeInstanceOf(ProviderError);
    expect(urls).toHaveLength(0);
  });

  it('reads the season’s weeks from the calendar: windows, labels, and the postseason’s own numbering', async () => {
    const { espn } = provider();
    const regular = await espn.getSeasonWeeks(SEASON);
    expect(regular).toHaveLength(15);
    expect(regular.find((week) => week.week === 6)).toEqual({
      week: 6,
      label: 'Week 6',
      startUtc: '2026-10-05T07:00:00.000Z',
      endUtc: '2026-10-12T06:59:00.000Z',
    });

    const raw = readCalendarWeeks(fixture('calendar'));
    expect(raw).not.toBeNull();
    const post = toSeasonWeeks(raw!, { year: 2026, type: 'postseason', week: null });
    expect(post.map((week) => [week.week, week.label])).toEqual([
      [1, 'Bowls'],
      [999, 'CFP'],
    ]);
    // A calendar for another year has no weeks for this season.
    expect(toSeasonWeeks(raw!, { year: 2027, type: 'regular', week: null })).toEqual([]);
    expect(toSeasonWeeks(raw!, { year: 2026, type: 'preseason', week: null })).toEqual([]);
  });
});

// ─── Against the real week and the real pick index ───────────────────────────

/** The plan's own measurement, recomputed from the raw payload with no app code at all. */
function measure(weekFixture: string): { both: Set<string>; oneSided: Set<string> } {
  const owners = realPickIndex();
  const body = fixture(weekFixture) as {
    events: { id: string; competitions: { competitors: { team: { id: string } }[] }[] }[];
  };
  const both = new Set<string>();
  const oneSided = new Set<string>();
  for (const event of body.events) {
    const owned = event.competitions[0]!.competitors.filter(
      (competitor) => owners[competitor.team.id] !== undefined,
    ).length;
    if (owned === 2) both.add(event.id);
    if (owned === 1) oneSided.add(event.id);
  }
  return { both, oneSided };
}

describe('the real week 6 against the real pick index (measured 2026-10-02)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date(WEEK_CAPTURED_AT));
  });

  it('returns the 12 matchups, UCLA at Oregon as one person’s, and none of the 22 one-sided games', async () => {
    install(realBoards());
    const { response, body } = await get<MatchupBoardResponse>('/api/matchups?week=6', espnEnv());
    expect(response.status).toBe(200);

    const { both, oneSided } = measure('scoreboard-week-6');
    expect(both.size).toBe(12);
    expect(oneSided.size).toBe(22);

    expect(body.week).toBe(6);
    expect(body.matchups).toHaveLength(12);
    expect(new Set(body.matchups.map((row) => row.providerGameId))).toEqual(both);
    for (const row of body.matchups) {
      expectWellFormed(row);
      expect(oneSided.has(row.providerGameId)).toBe(false);
    }

    const same = body.matchups.filter((row) => row.sameOwner);
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({
      providerGameId: '401858484',
      away: { team: { providerTeamId: '26' } },
      home: { team: { providerTeamId: '2483' } },
    });
    expect(same[0]!.home.owners.map((owner) => owner.displayName)).toEqual(['Wilson']);
    expect(same[0]!.away.owners.map((owner) => owner.displayName)).toEqual(['Wilson']);

    // Texas–Oklahoma is at a neutral site: "vs", not "at".
    expect(body.matchups.find((row) => row.providerGameId === '401856717')?.neutralSite).toBe(true);
  });

  it('orders the week by kickoff, a TBD kickoff last within its (Eastern) day', async () => {
    install(realBoards());
    const { body } = await get<MatchupBoardResponse>('/api/matchups?week=6', espnEnv());
    const rows = body.matchups;
    // Every week-6 game was upcoming when captured.
    expect(rows.every((row) => row.status === 'scheduled')).toBe(true);

    // Texas A&M at Missouri has no announced time, stamped 04:00Z Saturday:
    // midnight Eastern. It belongs to Saturday, and goes after every Saturday
    // game with a time, though its placeholder instant is the earliest of all.
    const tbdRows = rows.filter((row) => row.kickoffTbd);
    expect(tbdRows.map((row) => [row.away.team.abbreviation, row.home.team.abbreviation])).toEqual([
      ['TA&M', 'MIZ'],
    ]);
    const tbd = rows.indexOf(tbdRows[0]!);
    // Saturday in US Eastern: 04:00Z Saturday to 04:00Z Sunday.
    const easternSaturday = (row: Matchup): boolean =>
      row.kickoffUtc >= '2026-10-10T04:00' && row.kickoffUtc < '2026-10-11T04:00';
    const saturday = rows.filter((row) => !row.kickoffTbd && easternSaturday(row));
    expect(saturday).toHaveLength(9);
    for (const row of saturday) expect(rows.indexOf(row)).toBeLessThan(tbd);
    // Iowa at Washington is stamped Saturday in UTC (01:00Z) and is a Friday
    // night game in Eastern time, so it comes before the whole of Saturday.
    const friday = rows.find((row) => row.away.team.abbreviation === 'IOWA');
    expect(friday?.kickoffUtc).toBe('2026-10-10T01:00:00.000Z');
    expect(easternSaturday(friday!)).toBe(false);
    // And everything before Saturday is before it, in kickoff order.
    const timed = rows.filter((row) => !row.kickoffTbd).map((row) => row.kickoffUtc);
    expect(timed).toEqual([...timed].sort());
    expect(rows.slice(tbd + 1).every((row) => !easternSaturday(row))).toBe(true);
  });

  it('records are the provider’s, verbatim, and ranks are the app’s poll', async () => {
    install(realBoards());
    const { body } = await get<MatchupBoardResponse>('/api/matchups?week=6', espnEnv());
    const raw = fixture('scoreboard-week-6') as {
      events: {
        id: string;
        competitions: {
          competitors: { team: { id: string }; records?: { type: string; summary: string }[] }[];
        }[];
      }[];
    };
    for (const row of body.matchups) {
      const event = raw.events.find((candidate) => candidate.id === row.providerGameId)!;
      for (const side of [row.home, row.away]) {
        const competitor = event.competitions[0]!.competitors.find(
          (candidate) => candidate.team.id === side.team.providerTeamId,
        );
        const total = competitor?.records?.find((record) => record.type === 'total')?.summary;
        expect(side.record?.summary ?? null).toBe(total ?? null);
      }
    }
    const kinds = new Set(
      body.matchups.flatMap((row) => [row.home.ranking.kind, row.away.ranking.kind]),
    );
    expect(kinds).toEqual(new Set(['ranked', 'unranked']));
  });
});

describe('the real week 5: a final matchup and a same-owner game', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date(WEEK_CAPTURED_AT));
  });

  it('returns the 11 matchups, Florida at Missouri as one person’s, finals after upcoming', async () => {
    install(realBoards());
    const { body } = await get<MatchupBoardResponse>('/api/matchups?week=5', espnEnv());
    const { both, oneSided } = measure('scoreboard-week-5');
    expect(both.size).toBe(11);
    expect(oneSided.size).toBe(22);
    expect(new Set(body.matchups.map((row) => row.providerGameId))).toEqual(both);
    body.matchups.forEach(expectWellFormed);

    const same = body.matchups.filter((row) => row.sameOwner);
    expect(same.map((row) => [row.away.team.abbreviation, row.home.team.abbreviation])).toEqual([
      ['FLA', 'MIZ'],
    ]);

    // Pitt won at Virginia Tech 35–33 on the Thursday: the one final matchup.
    const final = body.matchups.filter((row) => row.status === 'final');
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({
      away: { team: { abbreviation: 'PITT' }, score: 35, winner: true },
      home: { team: { abbreviation: 'VT' }, score: 33, winner: false },
    });
    expect(body.matchups.at(-1)?.status).toBe('final');
    const sections = body.matchups.map(sectionOf);
    expect(sections).toEqual([...sections].sort());
  });
});

// ─── The mock, against the repo's seed ───────────────────────────────────────

describe('GET /api/matchups in mock mode (the seed: nine boards, four shared teams)', () => {
  it('opens on the current week, with the week list, and every row a real matchup', async () => {
    install();
    const { response, body } = await get<MatchupBoardResponse>('/api/matchups');
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Cache')).toMatch(/^(hit|miss|stale)$/);
    expect(body.week).toBe(6);
    expect(body.notice).toBeNull();
    expect(body.error).toBeNull();
    expect(body.weeks.map((week) => week.week)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(body.matchups.length).toBeGreaterThan(10);
    body.matchups.forEach(expectWellFormed);
  });

  it('shows every state a card must render in the week it opens on', async () => {
    install();
    const { body } = await get<MatchupBoardResponse>('/api/matchups');
    const statuses = new Set(body.matchups.map((row) => row.status));
    for (const status of ['live', 'scheduled', 'final', 'postponed'] as const) {
      expect(statuses, status).toContain(status);
    }
    expect(body.matchups.some((row) => row.kickoffTbd)).toBe(true);
    expect(body.anyLive).toBe(true);

    // Live first, then upcoming, then finals, then postponed (§51).
    const sections = body.matchups.map(sectionOf);
    expect(sections).toEqual([...sections].sort());
    expect(body.matchups[0]?.status).toBe('live');
    expect(body.matchups.at(-1)?.status).toBe('postponed');
  });

  it('shows a side with two owners, sorted (the seed shares Alabama, Texas, Ohio State, Notre Dame)', async () => {
    install();
    const { body } = await get<MatchupBoardResponse>('/api/matchups');
    const shared = body.matchups
      .flatMap((row) => [row.home, row.away])
      .filter((side) => side.owners.length > 1);
    expect(shared.length).toBeGreaterThan(0);
    for (const side of shared) {
      expect(side.owners.map((owner) => owner.displayName)).toContain('Jordan');
    }
  });

  it('has a same-owner game somewhere in the season, marked as such', async () => {
    install();
    const found: number[] = [];
    for (let week = 1; week <= 12; week += 1) {
      const { body } = await get<MatchupBoardResponse>(`/api/matchups?week=${String(week)}`);
      body.matchups.forEach(expectWellFormed);
      if (body.matchups.some((row) => row.sameOwner)) found.push(week);
    }
    expect(found.length).toBeGreaterThan(0);
  });

  it('carries rank and record, and keeps — distinct from NR when the poll fails', async () => {
    install();
    const normal = (await get<MatchupBoardResponse>('/api/matchups')).body;
    const kinds = new Set(
      normal.matchups.flatMap((row) => [row.home.ranking.kind, row.away.ranking.kind]),
    );
    expect(kinds).toEqual(new Set(['ranked', 'unranked']));
    expect(normal.matchups.some((row) => row.home.record !== null)).toBe(true);

    resetCacheTiers();
    resetInflight();
    const { body } = await get<MatchupBoardResponse>(
      '/api/matchups',
      testEnv({ SPORTS_PROVIDER_FAULT: 'rankings' }),
    );
    // Every rank `—`, nothing else lost.
    expect(
      body.matchups.every(
        (row) => row.home.ranking.kind === 'unavailable' && row.away.ranking.kind === 'unavailable',
      ),
    ).toBe(true);
    expect(body.matchups.map((row) => row.providerGameId)).toEqual(
      normal.matchups.map((row) => row.providerGameId),
    );
    expect(body.matchups.map((row) => row.home.record)).toEqual(
      normal.matchups.map((row) => row.home.record),
    );
  });

  it('answers a past week with its finals and a future week with its kickoffs', async () => {
    install();
    const past = (await get<MatchupBoardResponse>('/api/matchups?week=3')).body;
    expect(past.matchups.every((row) => row.status === 'final' || row.status === 'canceled')).toBe(
      true,
    );
    const future = (await get<MatchupBoardResponse>('/api/matchups?week=10')).body;
    expect(future.matchups.every((row) => row.status === 'scheduled')).toBe(true);
    expect(future.matchups.every((row) => row.kickoffTbd)).toBe(true);
    expect(future.anyLive).toBe(false);
  });

  it('a week the calendar does not list, or that is not a number, is a 400 before any read', async () => {
    const recorded = install();
    for (const path of [
      '/api/matchups?week=13',
      '/api/matchups?week=0',
      '/api/matchups?week=six',
    ]) {
      const { response, body } = await get<ApiErrorBody>(path);
      expect(response.status, path).toBe(400);
      expect(body.error.kind).toBe('invalid_request');
    }
    expect(recorded.restRequests).toHaveLength(0);
  });

  it('the offseason is an empty board with a reason, not an error', async () => {
    const recorded = install();
    const { response, body } = await get<MatchupBoardResponse>(
      '/api/matchups',
      testEnv({ SEASON_OVERRIDE: '2026:postseason' }),
    );
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ week: null, weeks: [], notice: 'offseason', matchups: [] });
    expect(recorded.restRequests).toHaveLength(0);
  });

  it('with no calendar and no known week, says so; with a week asked for, shows it', async () => {
    install();
    const env = testEnv({ SPORTS_PROVIDER_FAULT: 'calendar' });
    const unknown = (await get<MatchupBoardResponse>('/api/matchups', env)).body;
    expect(unknown).toMatchObject({ week: null, notice: 'week_unknown', matchups: [] });

    const asked = (await get<MatchupBoardResponse>('/api/matchups?week=6', env)).body;
    expect(asked.week).toBe(6);
    expect(asked.weeks).toEqual([]);
    expect(asked.matchups.length).toBeGreaterThan(0);
  });
});

// ─── Live rows ───────────────────────────────────────────────────────────────

describe('a live matchup takes its score, clock, and freshness from the slate', () => {
  it('is dated by the slate’s read, newer than the week document behind it', async () => {
    install();
    const t0 = new Date().toISOString();
    await get<MatchupBoardResponse>('/api/matchups');

    // Inside the week document's 15 minutes, past the slate's 25 seconds and
    // the composite's live 15 seconds.
    advanceMinutes(5);
    const t5 = new Date().toISOString();
    const { body } = await get<MatchupBoardResponse>('/api/matchups');

    const live = body.matchups.filter((row) => row.status === 'live');
    expect(live.length).toBeGreaterThan(0);
    const now = generateSeason({ year: 2026, type: 'regular', week: 6 }, Date.parse(t5));
    for (const row of live) {
      expect(row.freshness.fetchedAt).toBe(t5);
      expect(row.scoreUpdatedAt).toBe(t5);
      const truth = now.find((game) => game.providerGameId === row.providerGameId)!;
      expect([row.home.score, row.away.score, row.clock]).toEqual([
        truth.home.score,
        truth.away.score,
        truth.clock,
      ]);
    }
    const upcoming = body.matchups.find((row) => row.status === 'scheduled');
    expect(upcoming?.freshness.fetchedAt).toBe(t0);
    expect(upcoming?.scoreUpdatedAt).toBe(t0);
    // The board as a whole is as old as its oldest part.
    expect(body.freshness.fetchedAt).toBe(t0);
  });

  it('with the slate down, a live row is stale with its original time, and nothing claims to be current', async () => {
    install();
    const t0 = new Date().toISOString();
    const { response, body } = await get<MatchupBoardResponse>(
      '/api/matchups',
      testEnv({ SPORTS_PROVIDER_FAULT: 'slate' }),
    );
    expect(response.status).toBe(200);
    const live = body.matchups.filter((row) => row.status === 'live');
    expect(live.length).toBeGreaterThan(0);
    for (const row of live) {
      expect(row.freshness.state).toBe('stale');
      expect(row.freshness.fetchedAt).toBe(t0);
    }
    // Rows outside their live window were never going to the slate.
    expect(body.matchups.find((row) => row.status === 'scheduled')?.freshness.state).toBe('fresh');
    expect(body.freshness.state).toBe('stale');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=10');
    expect(response.headers.get('X-Cache')).toBe('stale');
  });

  it('shares the boards’ slate key, so a board and the matchup board are one slate read', async () => {
    install();
    const { body } = await get<MatchupBoardResponse>('/api/matchups');
    const live = body.matchups.find((row) => row.status === 'live')!;
    // A board read in the same isolate ten seconds later, inside the slate's
    // 25 s, gets the same slate entry: its score is dated by the matchup
    // board's read, not by one of its own.
    vi.setSystemTime(new Date(Date.now() + 10_000));
    const teamId = live.home.team.providerTeamId;
    const owner = live.home.owners[0]!.userId;
    const board = await app.request(`/api/users/${owner}/board`, {}, testEnv());
    const json = await board.json<BoardResponse>();
    const card = json.teams.find((team) => team.team.providerTeamId === teamId);
    expect(card?.snapshot.data?.liveUpdatedAt).toBe(live.scoreUpdatedAt);
    expect(live.scoreUpdatedAt).toBe(MOCK_NOW.replace('Z', '.000Z'));
  });
});

// ─── Faults, one at a time and together ──────────────────────────────────────

describe('faults', () => {
  it('week, cold: a clean unavailable, with the reference it was logged under', async () => {
    install();
    const { response, body } = await get<MatchupBoardResponse>(
      '/api/matchups',
      testEnv({ SPORTS_PROVIDER_FAULT: 'week' }),
    );
    expect(response.status).toBe(200);
    expect(body.freshness.state).toBe('unavailable');
    expect(body.matchups).toEqual([]);
    expect(body.error?.kind).toBe('provider_unavailable');
    expect(body.error?.requestId).toBe(response.headers.get('X-Request-Id'));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('week, warm past its TTL: stale, with the original fetchedAt', async () => {
    install();
    const t0 = new Date().toISOString();
    await get<MatchupBoardResponse>('/api/matchups');
    advanceMinutes(20);

    const { body } = await get<MatchupBoardResponse>(
      '/api/matchups',
      testEnv({ SPORTS_PROVIDER_FAULT: 'week' }),
    );
    expect(body.freshness).toMatchObject({ state: 'stale', fetchedAt: t0 });
    expect(body.matchups.length).toBeGreaterThan(0);
    const upcoming = body.matchups.find((row) => row.status === 'scheduled');
    expect(upcoming?.freshness).toMatchObject({ state: 'stale', fetchedAt: t0 });
    expect(body.error).toBeNull();
  });

  it('week, rankings, and slate together: unavailable, and still a 200', async () => {
    install();
    const { response, body } = await get<MatchupBoardResponse>(
      '/api/matchups',
      testEnv({ SPORTS_PROVIDER_FAULT: 'week,rankings,slate' }),
    );
    expect(response.status).toBe(200);
    expect(body.freshness.state).toBe('unavailable');
    expect(body.matchups).toEqual([]);
  });

  it('all: the season falls back to the date and the board says the week is unknown', async () => {
    install();
    const { response, body } = await get<MatchupBoardResponse>(
      '/api/matchups',
      testEnv({ SPORTS_PROVIDER_FAULT: 'all' }),
    );
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ notice: 'week_unknown', matchups: [] });
  });

  it('the database failing: an error with a reference, never an empty board', async () => {
    install(seedBoards(), 500);
    const { response, body } = await get<ApiErrorBody>('/api/matchups');
    // The application's convention for a PostgREST failure (as on the board).
    expect(response.status).toBe(500);
    expect(body.error.requestId).toBe(response.headers.get('X-Request-Id'));
    expect(JSON.stringify(body)).not.toContain('forced failure');
    expect(response.headers.get('Cache-Control')).toBeNull();
  });
});

// ─── The cache and the KV budget ─────────────────────────────────────────────

describe('the KV budget', () => {
  it('writes no matchup composite, and the week document at most once an hour', async () => {
    install();
    const kv = new FakeKv();
    const env = testEnv({ SPORTS_KV: kv.asNamespace() });
    const weekKey = (key: string): boolean => key.startsWith('v2|mock|week|');

    // An hour of polling: the composite expires every 15 s while live and the
    // week document every 15 minutes, and each refetch is a candidate write.
    for (let minute = 0; minute < 60; minute += 5) {
      await get<MatchupBoardResponse>('/api/matchups', env);
      advanceMinutes(5);
    }
    expect(kv.writes.filter((write) => weekKey(write.key))).toHaveLength(1);
    expect(kv.writes.some((write) => write.key.includes('|matchups|'))).toBe(false);

    const health = (await get<HealthResponse>('/api/health', env)).body;
    expect(health.cache.kvWrites.byCategory['week_games']).toBe(1);
    expect(health.cache.kvWrites.byCategory['matchup_composite']).toBeUndefined();

    // Past the hour, the next refresh may write again.
    advanceMinutes(10);
    await get<MatchupBoardResponse>('/api/matchups', env);
    expect(kv.writes.filter((write) => weekKey(write.key))).toHaveLength(2);
  });

  it('a second isolate serves the first one’s KV copy, without rewriting it', async () => {
    install();
    const kv = new FakeKv();
    const env = testEnv({ SPORTS_KV: kv.asNamespace() });
    const t0 = new Date().toISOString();
    await get<MatchupBoardResponse>('/api/matchups', env);
    const writes = kv.writes.length;

    // A fresh isolate: empty L1, the same KV.
    resetCacheTiers();
    resetInflight();
    advanceMinutes(2);
    const { body } = await get<MatchupBoardResponse>('/api/matchups', env);
    const upcoming = body.matchups.find((row) => row.status === 'scheduled');
    expect(upcoming?.freshness).toMatchObject({ state: 'cached', fetchedAt: t0 });
    // Only the live slate is new; it never reaches KV.
    expect(kv.writes).toHaveLength(writes);
  });

  it('a week whose every game is over is kept for a day', async () => {
    install();
    const kv = new FakeKv();
    await get<MatchupBoardResponse>(
      '/api/matchups?week=3',
      testEnv({ SPORTS_KV: kv.asNamespace() }),
    );
    const write = kv.writes.find((entry) => entry.key.startsWith('v2|mock|week|'));
    // TTL plus the stale window: a day plus a week.
    expect(write?.expirationTtl).toBe(8 * 24 * 60 * 60);
  });

  it('sends Cache-Control from the composite’s own expiry: 15 s while live, 60 s otherwise', async () => {
    install();
    const live = await get<MatchupBoardResponse>('/api/matchups');
    expect(live.response.headers.get('Cache-Control')).toBe('public, max-age=15');
    const quiet = await get<MatchupBoardResponse>('/api/matchups?week=10');
    expect(quiet.response.headers.get('Cache-Control')).toBe('public, max-age=60');
    const again = await get<MatchupBoardResponse>('/api/matchups?week=10');
    expect(again.response.headers.get('X-Cache')).toBe('hit');
    expect(again.body.matchups[0]?.freshness.state).toBe('cached');
  });
});

// ─── One game ────────────────────────────────────────────────────────────────

describe('GET /api/matchups/:gameId', () => {
  it('is one board row, for a game between boards', async () => {
    install();
    const board = (await get<MatchupBoardResponse>('/api/matchups')).body;
    const row = board.matchups.find((candidate) => candidate.status === 'scheduled')!;
    const { response, body } = await get<MatchupResponse>(`/api/matchups/${row.providerGameId}`);
    expect(response.status).toBe(200);
    expect(body.matchup).toMatchObject({
      providerGameId: row.providerGameId,
      home: { team: row.home.team, owners: row.home.owners, ranking: row.home.ranking },
      away: { team: row.away.team, owners: row.away.owners },
      sameOwner: row.sameOwner,
      status: row.status,
    });
    expectWellFormed(body.matchup);
  });

  it('a live game gets the slate’s score, as on the board', async () => {
    install();
    const board = (await get<MatchupBoardResponse>('/api/matchups')).body;
    const row = board.matchups.find((candidate) => candidate.status === 'live')!;
    const { body } = await get<MatchupResponse>(`/api/matchups/${row.providerGameId}`);
    expect(body.matchup).toMatchObject({
      status: 'live',
      clock: row.clock,
      home: { score: row.home.score },
      away: { score: row.away.score },
    });
  });

  it('works for any game: a side nobody has gets no owners and the provider’s identity', async () => {
    vi.setSystemTime(new Date(WEEK_CAPTURED_AT));
    install(realBoards());
    const { response, body } = await get<MatchupResponse>('/api/matchups/401858225', espnEnv());
    expect(response.status).toBe(200);
    for (const side of [body.matchup.home, body.matchup.away]) {
      if (side.owners.length === 0) expect(side.team.id).toBeNull();
      else expect(side.team.id).not.toBeNull();
    }
    expect(body.matchup.status).toBe('final');
  });

  it('a game that does not exist is a 404; a malformed id is a 404 before any read', async () => {
    const recorded = install();
    expect((await get<ApiErrorBody>('/api/matchups/99999999999999')).response.status).toBe(404);
    const before = recorded.requests.length;
    expect((await get<ApiErrorBody>('/api/matchups/not%20an%20id')).response.status).toBe(404);
    expect(recorded.requests).toHaveLength(before);
  });

  it('the game unreadable with nothing cached is a 503 with a reference', async () => {
    install();
    const board = (await get<MatchupBoardResponse>('/api/matchups')).body;
    const id = board.matchups[0]!.providerGameId;
    resetCacheTiers();
    resetInflight();
    const { response, body } = await get<ApiErrorBody>(
      `/api/matchups/${id}`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'game' }),
    );
    expect(response.status).toBe(503);
    expect(body.error.requestId).toBe(response.headers.get('X-Request-Id'));
  });
});

// ─── The pure parts ──────────────────────────────────────────────────────────

describe('compareRows: the day is the provider’s slate day, never the UTC date', () => {
  const row = (id: string, kickoffUtc: string, kickoffTbd = false): Matchup =>
    ({ providerGameId: id, kickoffUtc, kickoffTbd, status: 'scheduled', period: null }) as Matchup;

  it('puts a Saturday-night kickoff stamped Sunday in UTC before Saturday’s TBD game', () => {
    const rows = [
      row('tbd', '2026-10-10T04:00:00.000Z', true), // midnight Eastern, Saturday
      row('late', '2026-10-11T02:00:00.000Z'), // 10 PM Eastern, Saturday
      row('noon', '2026-10-10T16:00:00.000Z'),
      row('sunday', '2026-10-11T17:00:00.000Z'),
    ];
    const sorted = [...rows]
      .sort(compareRows(easternSlateKey))
      .map((entry) => entry.providerGameId);
    expect(sorted).toEqual(['noon', 'late', 'tbd', 'sunday']);
  });

  it('live, then upcoming, then final, then postponed and canceled', () => {
    const at = '2026-10-10T16:00:00.000Z';
    const rows = [
      { ...row('canceled', at), status: 'canceled' },
      { ...row('final', at), status: 'final' },
      row('upcoming', at),
      { ...row('postponed', at), status: 'postponed' },
      { ...row('delayed-mid-game', at), status: 'delayed', period: 2 },
      { ...row('live', at), status: 'live', period: 3 },
    ] as Matchup[];
    const sorted = [...rows]
      .sort(compareRows(easternSlateKey))
      .map((entry) => entry.providerGameId);
    expect(sorted).toEqual([
      'delayed-mid-game',
      'live',
      'upcoming',
      'final',
      'canceled',
      'postponed',
    ]);
  });
});

describe('indexPicks', () => {
  const board = (id: string, name: string, teams: { id: string; provider: 'espn' | 'mock' }[]) => ({
    user: { id, displayName: name },
    selections: teams.map((team, order) => ({
      id: `${id}-${String(order)}`,
      order: order + 1,
      createdAt: '2026-09-01T00:00:00Z',
      team: {
        id: `team-${team.provider}-${team.id}`,
        provider: team.provider,
        providerTeamId: team.id,
        name: `Team ${team.id}`,
        displayName: null,
        abbreviation: null,
        logoUrl: null,
        conference: null,
        primaryColor: null,
        altColor: null,
      },
    })),
  });

  it('counts only teams stored under the provider’s own id space, owners sorted by name', () => {
    const picks = indexPicks(
      [
        board('u2', 'Zed', [{ id: '1', provider: 'espn' }]),
        board('u1', 'Amy', [
          { id: '1', provider: 'espn' },
          { id: '2', provider: 'mock' },
        ]),
      ],
      'espn',
    );
    expect(picks.owners.get('1')?.map((owner) => owner.displayName)).toEqual(['Amy', 'Zed']);
    // Another namespace's team with a coincidentally equal id is somebody else's team.
    expect(picks.owners.has('2')).toBe(false);
    expect(picks.teams.get('1')?.id).toBe('team-espn-1');
  });
});

describe('defaultWeek', () => {
  const weeks = [
    {
      week: 1,
      label: 'Week 1',
      startUtc: '2026-09-01T07:00:00.000Z',
      endUtc: '2026-09-08T06:59:00.000Z',
    },
    {
      week: 2,
      label: 'Week 2',
      startUtc: '2026-09-08T07:00:00.000Z',
      endUtc: '2026-09-15T06:59:00.000Z',
    },
    {
      week: 3,
      label: 'Week 3',
      startUtc: '2026-09-22T07:00:00.000Z',
      endUtc: '2026-09-29T06:59:00.000Z',
    },
  ];
  const season = (week: number | null): Season => ({ year: 2026, type: 'regular', week });

  it('takes the season’s own week when the calendar lists it', () => {
    expect(defaultWeek(season(2), weeks, Date.parse('2026-09-25T00:00:00Z'))).toBe(2);
  });
  it('otherwise the week whose window holds now, then the next, then the last', () => {
    expect(defaultWeek(season(null), weeks, Date.parse('2026-09-10T00:00:00Z'))).toBe(2);
    expect(defaultWeek(season(9), weeks, Date.parse('2026-09-18T00:00:00Z'))).toBe(3);
    expect(defaultWeek(season(null), weeks, Date.parse('2026-08-01T00:00:00Z'))).toBe(1);
    expect(defaultWeek(season(null), weeks, Date.parse('2026-12-01T00:00:00Z'))).toBe(3);
  });
});
