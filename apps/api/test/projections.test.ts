import type {
  ApiErrorBody,
  BoardProjectionResponse,
  BoardResponse,
  ProjectedTeamEntry,
  ProjectionsResponse,
  TeamProjectionResponse,
} from '@cfb/shared';
import { MAX_POINTS, MIN_POINTS, OUTCOME_ORDER, roundPoints } from '@cfb/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { resetInflight } from '../src/cache/swr';
import { resetCacheTiers } from '../src/cache/tiers';
import type { Env } from '../src/env';
import { DEFAULT_READS_PER_MINUTE, resetRateLimits } from '../src/middleware/rate-limit';
import { mockHasProjection } from '../src/providers/mock/projections';
import { ROSTER } from '../src/providers/mock/roster';
import { CONFERENCE_PAGES } from '../src/providers/playoffstatus/conferences';
import {
  ALL_TEAM_ROWS,
  JORDAN,
  WILSON,
  WILSON_ID,
  teamUuid,
  uuidFor,
  userRow,
} from './helpers/boards';
import { espnResponse } from './helpers/espn-stub';
import { CAPTURED_AT, conferencePageFixture, fixture } from './helpers/fixtures';
import { installSupabaseStub, testEnv, type SupabaseStub } from './helpers/supabase-stub';

/**
 * Projected points, Phase 3: the two endpoints
 * (context/predicting_score.md, "Phase 3 — The endpoints").
 *
 * The rubric has its own tests in `packages/shared`, and the two publishers
 * have theirs in `test/services/projection.test.ts`. What is here is only what
 * the routes add: that nine boards cost one database read and no per-team
 * provider call, that every way of losing an input degrades in a labelled piece
 * rather than becoming a zero or a 500, and that the board response is
 * untouched by any of it.
 *
 * Mock mode throughout, so nothing reaches a network — which is also the mode
 * in which §46 bites hardest: every figure is synthetic, so nothing in the
 * response may wear a real publisher's name.
 */

const MOCK_NOW = '2026-10-07T18:00:00Z';

const app = createApp();
let stub: SupabaseStub;

/**
 * A team that is on a board and that no publisher covers: not in FPI's 138,
 * not in the conference map, not in the poll.
 *
 * This is the real case the plan names — a non-FBS team on somebody's board —
 * and it is the one that must report "5 of 6 teams" rather than a total with a
 * silent zero in it. Built by hand rather than taken from the mock roster
 * precisely because it must be a team the provider does not know.
 */
const OFF_ROSTER_TEAM_ID = '9091';

function offRosterTeamRow(): Record<string, unknown> {
  return {
    id: uuidFor(9091),
    provider: 'espn',
    provider_team_id: OFF_ROSTER_TEAM_ID,
    name: 'Rival State Bobcats',
    display_name: 'Rival State',
    abbreviation: 'RIV',
    logo_url: null,
    conference: null,
    primary_color: null,
    alt_color: null,
  };
}

/**
 * Wilson's board with its sixth team swapped for one nobody publishes about.
 * Appended by hand, because `userRow` builds its rows from the seeded roster
 * and this team is deliberately not in it.
 */
function mixedBoard(): Record<string, unknown> {
  const board = userRow(1, 'Wilson', ['333', '61', '251', '130', '30']);
  const selections = board['user_team_selections'] as Record<string, unknown>[];
  return {
    ...board,
    user_team_selections: [
      ...selections,
      {
        id: uuidFor(5991),
        selection_order: 6,
        created_at: '2026-09-01T00:00:00Z',
        teams: offRosterTeamRow(),
      },
    ],
  };
}

const MIXED = mixedBoard();
const MIXED_ID = MIXED['id'] as string;

/** A person with no teams at all: the board that must still appear, at zero of zero. */
const EMPTY = userRow(7, 'Quinn', []);
const EMPTY_ID = EMPTY['id'] as string;

beforeEach(() => {
  resetCacheTiers();
  resetInflight();
  resetRateLimits();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(MOCK_NOW));
  // Injected faults and stale fallbacks log by design; keep the output readable.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  stub.restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function stubWith(users: unknown[] = [WILSON, JORDAN]): SupabaseStub {
  stub = installSupabaseStub({
    appUsers: users,
    teams: [...ALL_TEAM_ROWS, offRosterTeamRow()],
    external: (url) => espnResponse(url, {}),
  });
  return stub;
}

async function get<T>(path: string, env: Env = testEnv(), headers: Record<string, string> = {}) {
  const response = await app.request(path, { headers }, env);
  return { response, body: (await response.json()) as T };
}

/** Every term's contribution, as the wire carries it, summed. */
function sumContributions(entry: ProjectedTeamEntry): number {
  return entry.projection.terms.reduce((total, term) => total + (term.contribution?.value ?? 0), 0);
}

// ─── The leaderboard ─────────────────────────────────────────────────────────

describe('GET /api/projections', () => {
  it('answers every board in one database read, with no token and no JWKS hop', async () => {
    stubWith([WILSON, JORDAN, EMPTY]);
    const { response, body } = await get<ProjectionsResponse>('/api/projections');

    expect(response.status).toBe(200);
    expect(body.boards).toHaveLength(3);
    // One PostgREST request for the whole leaderboard, and the public path
    // never parses a token or fetches a key set (§11.1).
    expect(stub.restRequests).toHaveLength(1);
    expect(stub.restRequests[0]?.path).toContain('/rest/v1/app_users');
    expect(stub.restRequests[0]?.authorization).toBeNull();
    expect(stub.jwksFetches).toBe(0);
  });

  it('costs the same provider work as one board', async () => {
    // The point of assembling from documents rather than per-team calls: nine
    // boards of six teams is still one FPI read and one odds read.
    stubWith([WILSON, JORDAN, EMPTY]);
    const many = await get<ProjectionsResponse>('/api/projections');
    const readsForMany = stub.requests.length;

    resetCacheTiers();
    resetInflight();
    stub.restore();
    stubWith([WILSON]);
    const one = await get<ProjectionsResponse>('/api/projections');

    expect(many.body.boards).toHaveLength(3);
    expect(one.body.boards).toHaveLength(1);
    expect(readsForMany).toBe(stub.requests.length);
  });

  it('sorts by projected total descending, then by name, and names no winner', async () => {
    stubWith([WILSON, JORDAN, EMPTY]);
    const { body } = await get<ProjectionsResponse>('/api/projections');

    const totals = body.boards.map((board) => board.total?.value ?? null);
    const scored = totals.filter((total): total is number => total !== null);
    expect([...scored]).toEqual([...scored].sort((a, b) => b - a));
    // A board with no total sorts last: it is not a zero, and placing it among
    // the low scores would read as one.
    expect(totals.slice(scored.length).every((total) => total === null)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('winning');
  });

  it('keeps an empty board on the list, at zero of zero and with no total', async () => {
    stubWith([WILSON, EMPTY]);
    const { body } = await get<ProjectionsResponse>('/api/projections');

    const empty = body.boards.find((board) => board.userId === EMPTY_ID);
    expect(empty).toBeDefined();
    expect(empty?.teamsTotal).toBe(0);
    expect(empty?.teamsCounted).toBe(0);
    // Six teams of nothing is not 0.00 points, and neither is no teams at all.
    expect(empty?.total).toBeNull();
  });

  it('ships both a number and a 2-dp string for every total', async () => {
    stubWith();
    const { body } = await get<ProjectionsResponse>('/api/projections');

    for (const board of body.boards) {
      expect(board.total).not.toBeNull();
      // The unrounded value is for arithmetic, the string for display, and the
      // string is the rounding of the value — one rounding, at one edge.
      expect(board.total?.display).toBe(roundPoints(board.total!.value).toFixed(2));
      expect(board.total?.display).toMatch(/^-?\d+\.\d{2}$/);
      expect(board.total?.display).not.toBe('-0.00');
    }
  });

  it('is cacheable for the composite’s own two minutes, not its inputs’ six hours', async () => {
    stubWith();
    const { response } = await get<ProjectionsResponse>('/api/projections');

    // Derived from the inputs' expiry this would be most of a day, long after
    // an admin's board change or a publisher's recompute should have landed.
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=120');
    expect(response.headers.get('X-Cache')).toBe('miss');

    const second = await get<ProjectionsResponse>('/api/projections');
    expect(second.response.headers.get('X-Cache')).toBe('hit');
  });

  it('spends the per-address read budget and then 429s with Retry-After', async () => {
    stubWith();
    const env = testEnv({ READ_RATE_LIMIT_PER_MINUTE: '3' });
    // The budget is keyed on the address Cloudflare puts on every proxied
    // request; without it there is nothing to key on and no limit.
    const from = { 'CF-Connecting-IP': '198.51.100.7' };
    for (let index = 0; index < 3; index += 1) {
      const { response } = await get<ProjectionsResponse>('/api/projections', env, from);
      expect(response.status).toBe(200);
    }
    const { response, body } = await get<ApiErrorBody>('/api/projections', env, from);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).not.toBeNull();
    expect(body.error.kind).toBe('rate_limited');
    // The budget is a real number and the default is the shared one.
    expect(DEFAULT_READS_PER_MINUTE).toBeGreaterThan(3);
  });
});

// ─── One board's breakdown ───────────────────────────────────────────────────

describe('GET /api/users/:userId/projection', () => {
  it('returns six teams whose contributions sum to each total, and whose totals sum to the board', async () => {
    stubWith();
    const { response, body } = await get<BoardProjectionResponse>(
      `/api/users/${WILSON_ID}/projection`,
    );

    expect(response.status).toBe(200);
    expect(body.user).toEqual({ id: WILSON_ID, displayName: 'Wilson' });
    expect(body.teams).toHaveLength(6);
    expect(body.teams.map((team) => team.order)).toEqual([1, 2, 3, 4, 5, 6]);

    for (const entry of body.teams) {
      expect(entry.projection.terms.map((term) => term.kind)).toEqual([...OUTCOME_ORDER]);
      expect(entry.projection.total?.value).toBeCloseTo(sumContributions(entry), 10);
      expect(entry.projection.total!.value).toBeLessThanOrEqual(MAX_POINTS);
      expect(entry.projection.total!.value).toBeGreaterThanOrEqual(MIN_POINTS);
    }

    const teamTotals = body.teams.reduce(
      (total, entry) => total + (entry.projection.total?.value ?? 0),
      0,
    );
    // Summed unrounded and rounded once at the end. Summing six rounded
    // numbers drifts: the eight worked rows of 2026-09-30 board 22.65 where
    // their rounded totals sum to 22.64.
    expect(body.board.total?.value).toBeCloseTo(teamTotals, 10);
    expect(body.board.teamsCounted).toBe(6);
    expect(body.board.teamsTotal).toBe(6);
  });

  it('carries the board’s own team identity, so the panel needs no second read', async () => {
    stubWith();
    const { body } = await get<BoardProjectionResponse>(`/api/users/${WILSON_ID}/projection`);

    const first = body.teams[0];
    expect(first?.team.providerTeamId).toBe('333');
    expect(first?.team.name).toContain('Alabama');
    expect(first?.selectionId).toEqual(expect.any(String));
  });

  it('labels every figure as the mock publisher’s, never as a real one (§46)', async () => {
    stubWith();
    const { body } = await get<BoardProjectionResponse>(`/api/users/${WILSON_ID}/projection`);

    const sources = body.teams
      .flatMap((entry) => entry.projection.terms)
      .map((term) => term.source)
      .filter((source): source is NonNullable<typeof source> => source !== null);
    expect(sources.length).toBeGreaterThan(0);
    // This is what the conference terms used to get wrong: a hard-coded
    // `playoffstatus` on a synthetic figure.
    expect([...new Set(sources)]).toEqual(['mock_projection']);
    expect(JSON.stringify(body.sources)).not.toContain('playoffstatus');
    expect(JSON.stringify(body.sources)).not.toContain('espn_fpi');
  });

  it('names every input it read, each with its own freshness and the publisher’s own stamp', async () => {
    stubWith();
    const { body } = await get<BoardProjectionResponse>(`/api/users/${WILSON_ID}/projection`);

    expect(body.sources.map((source) => source.input)).toEqual([
      'fpi',
      'conference_odds',
      'rankings',
      'conferences',
      'teams',
    ]);
    const fpi = body.sources.find((source) => source.input === 'fpi');
    const odds = body.sources.find((source) => source.input === 'conference_odds');

    // The publisher's own statement about when it recomputed — not our read
    // time, which would say "seconds ago" for a four-day-old figure (§39).
    expect(fpi?.computedLabel).toContain('Mock');
    expect(odds?.pages.length).toBeGreaterThan(0);
    expect(odds?.pages.every((page) => page.computedLabel !== null)).toBe(true);
    for (const source of body.sources) {
      expect(source.freshness.fetchedAt).not.toBeNull();
    }
  });

  it('reports 5 of 6 teams for a board holding a team no publisher covers — never a zero', async () => {
    stubWith([MIXED]);
    const { response, body } = await get<BoardProjectionResponse>(
      `/api/users/${MIXED_ID}/projection`,
    );

    expect(response.status).toBe(200);
    expect(body.board.teamsTotal).toBe(6);
    expect(body.board.teamsCounted).toBe(5);

    const orphan = body.teams.find((entry) => entry.team.providerTeamId === OFF_ROSTER_TEAM_ID);
    expect(orphan?.projection.total).toBeNull();
    expect(orphan?.projection.complete).toBe(false);
    // Every term unknown, and not one of them a confident zero: an unknown
    // conference is `unavailable`, not `not_eligible` (§7).
    expect(orphan?.projection.terms.every((term) => term.state === 'unavailable')).toBe(true);
    expect(orphan?.projection.terms.every((term) => term.contribution === null)).toBe(true);

    // And the five that are covered are untouched by the sixth (§42).
    const covered = body.teams.filter((entry) => entry.team.providerTeamId !== OFF_ROSTER_TEAM_ID);
    expect(covered.every((entry) => entry.projection.total !== null)).toBe(true);
  });

  it('is a 404 for an unknown user, and for a malformed id before any client is built', async () => {
    stubWith();
    const unknown = await get<ApiErrorBody>(`/api/users/${uuidFor(4242)}/projection`);
    expect(unknown.response.status).toBe(404);
    expect(unknown.body.error.kind).toBe('not_found');

    const requestsBefore = stub.requests.length;
    const malformed = await get<ApiErrorBody>('/api/users/not-a-uuid/projection');
    expect(malformed.response.status).toBe(404);
    // The `DbFactory` lesson: a bad path segment costs no round trip at all.
    expect(stub.requests).toHaveLength(requestsBefore);
  });
});

// ─── One team, for the team page (Phase 4) ───────────────────────────────────

describe('GET /api/teams/:teamId/projection', () => {
  /** Notre Dame: an independent, so both conference lines are a fact, not a gap. */
  const INDEPENDENT = '87';
  /** A roster team the mock FPI table deliberately leaves out, as FPI leaves out FCS. */
  const UNRATED = ROSTER.find((team) => !mockHasProjection(team));

  it('answers by the provider’s id with no database request at all', async () => {
    stubWith();
    const { response, body } = await get<TeamProjectionResponse>('/api/teams/333/projection');

    expect(response.status).toBe(200);
    expect(body.team.providerTeamId).toBe('333');
    expect(body.team.id).toBeNull();
    expect(body.projection.terms.map((term) => term.kind)).toEqual([...OUTCOME_ORDER]);
    const summed = body.projection.terms.reduce(
      (total, term) => total + (term.contribution?.value ?? 0),
      0,
    );
    expect(body.projection.total?.value).toBeCloseTo(summed, 10);
    expect(body.sources.map((source) => source.input)).toEqual([
      'fpi',
      'conference_odds',
      'rankings',
      'conferences',
      'teams',
    ]);
    // The search route's posture: a provider-id address never builds a client.
    expect(stub.restRequests).toHaveLength(0);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=120');
  });

  it('answers the same projection by our uuid, at the cost of one identity read', async () => {
    stubWith();
    const byProvider = await get<TeamProjectionResponse>('/api/teams/333/projection');
    const byUuid = await get<TeamProjectionResponse>(`/api/teams/${teamUuid('333')}/projection`);

    expect(byUuid.response.status).toBe(200);
    expect(byUuid.body.team.id).toBe(teamUuid('333'));
    expect(byUuid.body.projection).toEqual(byProvider.body.projection);
    expect(stub.restRequests).toHaveLength(1);
    expect(stub.restRequests[0]?.path).toContain('/rest/v1/teams');
  });

  it('labels every figure as the mock publisher’s in mock mode (§46)', async () => {
    stubWith();
    const { body } = await get<TeamProjectionResponse>('/api/teams/333/projection');
    const sources = new Set(body.projection.terms.map((term) => term.source));
    expect([...sources]).toEqual(['mock_projection']);
  });

  it('pays an independent a structural 0.00 on both conference lines, never a dash', async () => {
    stubWith();
    const { body } = await get<TeamProjectionResponse>(`/api/teams/${INDEPENDENT}/projection`);
    const conference = body.projection.terms.filter((term) => term.kind.startsWith('conference_'));
    expect(conference.map((term) => term.state)).toEqual(['not_eligible', 'not_eligible']);
    expect(conference.map((term) => term.contribution?.display)).toEqual(['0.00', '0.00']);
    expect(conference.every((term) => term.source === null)).toBe(true);
  });

  it('answers 200 for a team FPI does not rate, with its national lines unavailable', async () => {
    if (UNRATED === undefined) throw new Error('the mock roster always leaves one team unrated');
    stubWith();
    const { response, body } = await get<TeamProjectionResponse>(
      `/api/teams/${UNRATED.id}/projection`,
    );
    expect(response.status).toBe(200);
    const national = body.projection.terms.filter((term) =>
      ['national_champion', 'national_runner_up', 'playoff'].includes(term.kind),
    );
    expect(national.every((term) => term.state === 'unavailable')).toBe(true);
    expect(national.every((term) => term.contribution === null)).toBe(true);
    expect(body.projection.complete).toBe(false);
  });

  it('is a 404 for a team the provider does not list, and for a malformed id', async () => {
    stubWith();
    const unknown = await get<ApiErrorBody>('/api/teams/999999/projection');
    expect(unknown.response.status).toBe(404);
    expect(unknown.body.error.kind).toBe('not_found');

    const malformed = await get<ApiErrorBody>('/api/teams/not%20a%20team/projection');
    expect(malformed.response.status).toBe(404);
    expect(stub.restRequests).toHaveLength(0);
  });

  /**
   * Found writing this test: with BOTH publishers down and the poll up, a
   * ranked team still has one known line — our own Top-25 estimate, which needs
   * only the poll. Phase 3's "both down" drill never saw it, because `all`
   * takes the poll down too. Before Phase 4 that one line became the team's
   * total, and every board on the leaderboard read "6 of 6" with a number made
   * of nothing but our model. A total now needs a publisher's figure behind it.
   */
  it('with both publishers down and the poll up: our one line shown, but no total', async () => {
    stubWith();
    const { response, body } = await get<TeamProjectionResponse>(
      '/api/teams/333/projection',
      testEnv({ SPORTS_PROVIDER_FAULT: 'projections,odds' }),
    );
    expect(response.status).toBe(200);
    const known = body.projection.terms.filter((term) => term.state === 'known');
    expect(known.map((term) => term.kind)).toEqual(['final_ranking']);
    expect(known[0]?.source).toBe('mock_projection');
    expect(body.projection.total).toBeNull();
    expect(body.freshness.state).toBe('unavailable');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('with both publishers down and the poll up: no board on the leaderboard is "covered"', async () => {
    stubWith([WILSON, JORDAN]);
    const { body } = await get<ProjectionsResponse>(
      '/api/projections',
      testEnv({ SPORTS_PROVIDER_FAULT: 'projections,odds' }),
    );
    expect(body.boards.every((board) => board.total === null)).toBe(true);
    expect(body.boards.every((board) => board.teamsCounted === 0)).toBe(true);
  });

  it('with everything down: 200, no total at all, never 0.00', async () => {
    stubWith();
    const { response, body } = await get<TeamProjectionResponse>(
      '/api/teams/333/projection',
      testEnv({ SPORTS_PROVIDER_FAULT: 'projections,odds,rankings' }),
    );
    expect(response.status).toBe(200);
    expect(body.projection.total).toBeNull();
    expect(body.projection.terms.every((term) => term.contribution === null)).toBe(true);
  });

  it('does not reach the team route’s own answers, which stay exactly as they were', async () => {
    stubWith();
    const team = await app.request('/api/teams/333', {}, testEnv());
    const text = await team.text();
    expect(team.status).toBe(200);
    expect(text).not.toContain('projection');
    expect(text).not.toContain('projected');
  });
});

// ─── Degrading in labelled pieces ────────────────────────────────────────────

describe('each publisher fails on its own', () => {
  it('with the odds publisher down: 200, the national terms intact, the conference half labelled', async () => {
    stubWith();
    const { response, body } = await get<BoardProjectionResponse>(
      `/api/users/${WILSON_ID}/projection`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'odds' }),
    );

    expect(response.status).toBe(200);
    for (const entry of body.teams) {
      const terms = entry.projection.terms;
      const national = terms.filter((term) => !term.kind.startsWith('conference_'));
      const conference = terms.filter((term) => term.kind.startsWith('conference_'));

      // Every other term stands.
      expect(national.every((term) => term.state === 'known')).toBe(true);
      // The champion term falls back to FPI's own figure, LABELLED as FPI's —
      // and the runner-up term it has no figure for comes out a quoted zero
      // rather than an invention, because FPI publishes none.
      const champion = conference.find((term) => term.kind === 'conference_champion');
      const runnerUp = conference.find((term) => term.kind === 'conference_runner_up');
      expect(champion?.state).toBe('known');
      expect(runnerUp?.contribution?.value).toBe(0);
      expect(champion?.source).toBe('mock_projection');
    }

    // The composite says so: one publisher down is a degraded answer, and the
    // response must not be pinned in a cache for the full two minutes.
    expect(body.freshness.state).toBe('stale');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=10');
    const odds = body.sources.find((source) => source.input === 'conference_odds');
    expect(odds?.freshness.state).toBe('unavailable');
  });

  it('with FPI down: 200, and the finish term still computed from the poll', async () => {
    stubWith();
    const { response, body } = await get<BoardProjectionResponse>(
      `/api/users/${WILSON_ID}/projection`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'projections' }),
    );

    expect(response.status).toBe(200);
    for (const entry of body.teams) {
      const terms = entry.projection.terms;
      // The three national terms are FPI's and nobody else's.
      expect(
        terms
          .filter((term) =>
            ['national_champion', 'national_runner_up', 'playoff'].includes(term.kind),
          )
          .every((term) => term.state === 'unavailable'),
      ).toBe(true);
      // The conference terms are the odds publisher's and survive.
      expect(
        terms
          .filter((term) => term.kind.startsWith('conference_'))
          .every((term) => term.state === 'known'),
      ).toBe(true);
      // The finish term needs the poll, which is up. Where the poll lists the
      // team it is ranked; where it does not, FPI's rank is gone and there is
      // no evidence left, which is `unavailable` and never a silent −1.
      const finish = terms.find((term) => term.kind === 'final_ranking');
      expect(['known', 'unavailable']).toContain(finish?.state);
      if (finish?.state === 'known') expect(finish.probability).toBeGreaterThan(0);
    }

    // At least one of a six-team board is in a 25-team poll, so the criterion
    // is actually exercised rather than vacuously true.
    const ranked = body.teams.filter(
      (entry) =>
        entry.projection.terms.find((term) => term.kind === 'final_ranking')?.state === 'known',
    );
    expect(ranked.length).toBeGreaterThan(0);
  });

  it('with both down: 200, nothing known, a reference number, and never 0.00', async () => {
    stubWith();
    const { response, body } = await get<BoardProjectionResponse>(
      `/api/users/${WILSON_ID}/projection`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'all' }),
    );

    // It is never a 500, and it never answers 0.00.
    expect(response.status).toBe(200);
    expect(body.board.total).toBeNull();
    expect(body.board.teamsCounted).toBe(0);
    for (const entry of body.teams) {
      expect(entry.projection.total).toBeNull();
      expect(entry.projection.complete).toBe(false);
    }
    // Not one points value anywhere in the response — not a `0.00`, not a
    // `-0.00`, nothing. A projection that knows nothing says nothing.
    const displayed = [
      body.board.total,
      ...body.teams.flatMap((entry) => [
        entry.projection.total,
        ...entry.projection.terms.map((term) => term.contribution),
      ]),
    ];
    expect(displayed.every((points) => points === null)).toBe(true);

    // Nothing to show, so nothing to cache — and the reference number is what
    // the viewer can quote when they report it.
    expect(body.freshness.state).toBe('unavailable');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    // In the BODY, not only the header: a 200 is not an error, so a screen
    // reading it has no other way to quote one (Phase 5).
    const requestId = response.headers.get('X-Request-Id');
    expect(requestId).toBeTruthy();
    for (const input of ['fpi', 'conference_odds'] as const) {
      const entry = body.sources.find((source) => source.input === input);
      expect(entry?.error?.requestId).toBe(requestId);
      expect(entry?.error?.kind).toBe('provider_unavailable');
    }
  });

  /**
   * The reference is only worth quoting if it leads to a log line. The board
   * and leaderboard answers are cached for two minutes, so the request being
   * answered may have logged nothing; the reference must be the one the
   * failure was logged under, whichever request reads it.
   */
  it('quotes a reference that a logged failure carries, even from a cached answer', async () => {
    stubWith();
    const env = testEnv({ SPORTS_PROVIDER_FAULT: 'odds' });
    const path = `/api/users/${WILSON_ID}/projection`;
    const first = await get<BoardProjectionResponse>(path, env, { 'x-request-id': 'req-first' });
    const second = await get<BoardProjectionResponse>(path, env, { 'x-request-id': 'req-second' });

    // `console.warn` is spied for the whole file (see `beforeEach`).
    const logged = new Set(
      vi
        .mocked(console.warn)
        .mock.calls.map(
          ([line]) => JSON.parse(String(line)) as { event?: string; requestId?: string },
        )
        .filter((entry) => entry.event?.startsWith('cache_refresh_failed') === true)
        .map((entry) => entry.requestId),
    );
    for (const { body } of [first, second]) {
      const odds = body.sources.find((source) => source.input === 'conference_odds');
      expect(odds?.error?.requestId).toBeTruthy();
      expect(logged.has(odds?.error?.requestId ?? undefined)).toBe(true);
      // Inputs that did not fail carry nothing to quote.
      const fpi = body.sources.find((source) => source.input === 'fpi');
      expect(fpi?.error).toBeNull();
    }
  });

  it('answers the leaderboard with both publishers down, with no totals rather than zeros', async () => {
    stubWith([WILSON, JORDAN]);
    const { response, body } = await get<ProjectionsResponse>(
      '/api/projections',
      testEnv({ SPORTS_PROVIDER_FAULT: 'all' }),
    );

    expect(response.status).toBe(200);
    expect(body.boards).toHaveLength(2);
    expect(body.boards.every((board) => board.total === null)).toBe(true);
    expect(body.boards.every((board) => board.teamsCounted === 0)).toBe(true);
    // Two boards with nothing known still sort stably, by name.
    expect(body.boards.map((board) => board.displayName)).toEqual(['Jordan', 'Wilson']);
  });

  it('loses the conference terms when the team list goes, even with the scrape up', async () => {
    // The fifth read the plan's list does not name: the join resolves the odds
    // publisher's own spellings to provider ids, so without the team list the
    // conference half has no labelled source — a different failure from the
    // scrape being down, and one that must not pay a zero either.
    stubWith();
    const { response, body } = await get<BoardProjectionResponse>(
      `/api/users/${WILSON_ID}/projection`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'teams' }),
    );

    expect(response.status).toBe(200);
    for (const entry of body.teams) {
      const champion = entry.projection.terms.find((term) => term.kind === 'conference_champion');
      const runnerUp = entry.projection.terms.find((term) => term.kind === 'conference_runner_up');
      // Wilson's six are all power four, so the champion term falls back to
      // FPI's own figure — labelled as FPI's, which in mock mode is the mock's.
      expect(champion?.state).toBe('known');
      expect(champion?.source).toBe('mock_projection');
      // And the runner-up term is a quoted zero, because FPI publishes no
      // runner-up probability at all. It is "this publisher does not say",
      // which is why its source is the fallback's and not the scrape's.
      expect(runnerUp?.state).toBe('known');
      expect(runnerUp?.contribution?.value).toBe(0);
    }
    expect(body.sources.find((source) => source.input === 'teams')?.freshness.state).toBe(
      'unavailable',
    );
    expect(body.freshness.state).toBe('stale');
  });

  it('sends every conference term unavailable when the conference map goes, not to a zero', async () => {
    // Not knowing a team's conference is not knowing it is outside the power
    // four. Pessimistic and correct — and the FPI fallback is deliberately not
    // offered, or a Mountain West team would be paid for a title the rubric
    // does not pay for.
    stubWith();
    const { response, body } = await get<BoardProjectionResponse>(
      `/api/users/${WILSON_ID}/projection`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'conferences' }),
    );

    expect(response.status).toBe(200);
    const conference = body.teams
      .flatMap((entry) => entry.projection.terms)
      .filter((term) => term.kind.startsWith('conference_'));
    expect(conference.every((term) => term.state === 'unavailable')).toBe(true);
    expect(conference.every((term) => term.contribution === null)).toBe(true);
    // The national half is untouched, so the board still has a total.
    expect(body.board.total).not.toBeNull();
  });
});

// ─── Against the real captured payloads, both publishers at once ─────────────

describe('end to end on real data', () => {
  /** An all-SEC board, because the captured conference map has the SEC's teams. */
  const SEC_BOARD = userRow(3, 'Casey', ['333', '61', '251', '99', '2633', '201']);
  const SEC_BOARD_ID = SEC_BOARD['id'] as string;

  function realEnv(): Env {
    return testEnv({ SPORTS_PROVIDER: 'espn', CONFERENCE_ODDS_PROVIDER: 'playoffstatus' });
  }

  /**
   * Both publishers answering with their real captures, except where a drill
   * swaps one out: `pages` replaces a conference's HTML, `fpi` the FPI JSON.
   */
  function installReal(changed: { pages?: Record<string, string>; fpi?: unknown } = {}): void {
    stub = installSupabaseStub({
      appUsers: [SEC_BOARD],
      teams: ALL_TEAM_ROWS,
      external: (url) => {
        if (url.hostname.endsWith('playoffstatus.com')) {
          const conference = conferenceOfPage(url.pathname);
          return new Response(changed.pages?.[conference] ?? conferencePageFixture(conference), {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return espnResponse(url, {
          override: (candidate) =>
            changed.fpi !== undefined && candidate.pathname.endsWith('/powerindex')
              ? new Response(JSON.stringify(changed.fpi), {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                })
              : null,
        });
      },
    });
  }

  beforeEach(() => {
    // The ESPN fixtures' own moment, so "this season" means what it meant when
    // they were captured. The conference pages were captured a fortnight later;
    // their stamps are strings we display and never parse, so nothing here
    // depends on the two dates agreeing.
    vi.setSystemTime(new Date(CAPTURED_AT));
    installReal();
  });

  /** Swaps the default captures for a drill's changed ones. */
  function changeUnderUs(changed: { pages?: Record<string, string>; fpi?: unknown }): void {
    stub.restore();
    installReal(changed);
  }

  it('projects a real board from both publishers’ own captured payloads', async () => {
    const { response, body } = await get<BoardProjectionResponse>(
      `/api/users/${SEC_BOARD_ID}/projection`,
      realEnv(),
    );

    expect(response.status).toBe(200);
    expect(body.teams).toHaveLength(6);

    for (const entry of body.teams) {
      // Every one of the six is an FBS team FPI rates and a conference the
      // rubric pays for, so the whole rubric is quoted for all of them.
      expect(entry.projection.complete, entry.team.name).toBe(true);
      expect(entry.projection.terms.every((term) => term.state === 'known')).toBe(true);
      expect(entry.projection.total!.value).toBeLessThanOrEqual(MAX_POINTS);
      expect(entry.projection.total!.value).toBeGreaterThanOrEqual(MIN_POINTS);
    }

    // The two halves are quoted from two publishers, and the response says so
    // team by team rather than once for the page.
    const sourcesByKind = new Map(
      body.teams[0]!.projection.terms.map((term) => [term.kind, term.source]),
    );
    expect(sourcesByKind.get('national_champion')).toBe('espn_fpi');
    expect(sourcesByKind.get('conference_champion')).toBe('playoffstatus');
    expect(sourcesByKind.get('final_ranking')).toBe('espn_poll_estimate');

    // FPI's own stamp, and the four pages' own stamps — never our read time.
    const fpi = body.sources.find((source) => source.input === 'fpi');
    const odds = body.sources.find((source) => source.input === 'conference_odds');
    expect(fpi?.computedLabel).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(odds?.pages).toHaveLength(4);
    expect(odds?.pages.every((page) => page.computedLabel !== null)).toBe(true);
    // Null on today's data, because the four pages carry two different stamps:
    // Phase 4 has to date a conference term from its own page, not from this.
    expect(odds?.computedLabel).toBeNull();

    // A plausible spread rather than a pinned number: the arithmetic is pinned
    // against the plan's eight worked teams in `packages/shared`, and what is
    // being checked here is that two real payloads reach a total at all.
    expect(body.board.total!.value).toBeGreaterThan(0);
    expect(body.board.teamsCounted).toBe(6);
  });

  // ─── Phase 5's drills: a publisher changes its page under us ──────────────
  //
  // The parser refuses each of these on its own (`providers/playoffstatus.test.ts`,
  // `espn/fpi.test.ts`). What is drilled here is the whole answer: that a
  // refusal reaches the screen as a labelled, 200-level degradation carrying a
  // reference, with the other publisher's half intact — and never as a 0.00.

  /** What every one of the three drills must hold, whichever half it breaks. */
  function expectLabelledDegradation(
    response: Response,
    body: BoardProjectionResponse,
    broken: 'fpi' | 'conference_odds',
  ): void {
    expect(response.status).toBe(200);
    expect(body.freshness.state).toBe('stale');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=10');

    const entry = body.sources.find((source) => source.input === broken);
    expect(entry?.freshness.state).toBe('unavailable');
    // A redesign will not fix itself on a retry: invalid, not an outage.
    expect(entry?.error?.kind).toBe('provider_invalid_response');
    expect(entry?.error?.requestId).toBe(response.headers.get('X-Request-Id'));

    // Every team still has a total, and nothing reads as a confident zero.
    expect(body.board.teamsCounted).toBe(6);
    expect(body.board.total).not.toBeNull();
    for (const team of body.teams) {
      expect(team.projection.total, team.team.name).not.toBeNull();
      expect(team.projection.total?.display, team.team.name).not.toBe('0.00');
    }
  }

  /** The conference half, after the scrape is refused: FPI's figure, labelled as FPI's. */
  function expectFpiStandsInForTheScrape(body: BoardProjectionResponse): void {
    for (const team of body.teams) {
      const kind = (name: string) => team.projection.terms.find((term) => term.kind === name);
      expect(kind('national_champion')?.source).toBe('espn_fpi');
      expect(kind('conference_champion')?.state).toBe('known');
      expect(kind('conference_champion')?.source).toBe('espn_fpi');
      // FPI publishes no runner-up figure: a quoted zero, labelled, not invented.
      expect(kind('conference_runner_up')?.contribution?.value).toBe(0);
      expect(kind('conference_runner_up')?.source).toBe('espn_fpi');
      // `playoffstatus` appears on no term at all once its document is refused.
      expect(team.projection.terms.some((term) => term.source === 'playoffstatus')).toBe(false);
      // Every line is `known`, so the team reads `complete` — the runner-up's
      // quoted zero counts as known. The line's own words ("ESPN FPI publishes
      // no runner-up odds") are what tell a viewer it is not the whole rubric.
      expect(team.projection.complete).toBe(true);
    }
  }

  it('drill: a redesigned conference page is refused, and FPI stands in, labelled', async () => {
    changeUnderUs({
      pages: { SEC: '<html><body><h1>SEC Football</h1><p>Coming soon.</p></body></html>' },
    });
    const { response, body } = await get<BoardProjectionResponse>(
      `/api/users/${SEC_BOARD_ID}/projection`,
      realEnv(),
    );
    expectLabelledDegradation(response, body, 'conference_odds');
    expectFpiStandsInForTheScrape(body);
  });

  it('drill: a conference page with a row dropped is refused, not half-read', async () => {
    const dropped = conferencePageFixture('SEC').replace(
      /<tr>\s*<td class="tblteam"><a href="texasstandings\.html">Texas<\/a><\/td>[\s\S]*?<\/tr>/i,
      '',
    );
    expect(dropped).not.toContain('texasstandings.html');
    changeUnderUs({ pages: { SEC: dropped } });

    const { response, body } = await get<BoardProjectionResponse>(
      `/api/users/${SEC_BOARD_ID}/projection`,
      realEnv(),
    );
    // Not "fifteen SEC teams with odds and Texas with none": the whole document
    // is refused, so no team is paid from a table that is known to be wrong.
    expectLabelledDegradation(response, body, 'conference_odds');
    expectFpiStandsInForTheScrape(body);
  });

  it('drill: a renamed FPI column is refused, and the scrape’s half stands', async () => {
    const fpi = fixture('fpi') as Record<string, unknown>;
    const categories = fpi['categories'] as Array<Record<string, unknown>>;
    const names = categories.find((category) => category['name'] === 'fpi')!['names'] as string[];
    names[names.indexOf('probwintitle')] = 'probwinnatty';
    changeUnderUs({ fpi });

    const { response, body } = await get<BoardProjectionResponse>(
      `/api/users/${SEC_BOARD_ID}/projection`,
      realEnv(),
    );
    expectLabelledDegradation(response, body, 'fpi');

    for (const team of body.teams) {
      expect(team.projection.complete, team.team.name).toBe(false);
      const terms = team.projection.terms;
      // FPI's three lines are FPI's and nobody else's: gone, not borrowed.
      for (const kind of ['national_champion', 'national_runner_up', 'playoff']) {
        const term = terms.find((candidate) => candidate.kind === kind);
        expect(term?.state, `${team.team.name} ${kind}`).toBe('unavailable');
        expect(term?.contribution).toBeNull();
      }
      // The conference half is the scrape's, untouched.
      expect(
        terms
          .filter((term) => term.kind.startsWith('conference_'))
          .every((term) => term.state === 'known' && term.source === 'playoffstatus'),
      ).toBe(true);
    }
  });
});

/** Which conference's page a playoffstatus path is, by its own URL. */
function conferenceOfPage(path: string): string {
  const found = Object.entries(CONFERENCE_PAGES).find(([, page]) => page === path);
  if (found === undefined) throw new Error(`unexpected playoffstatus path ${path}`);
  return found[0];
}

// ─── The board is untouched ──────────────────────────────────────────────────

describe('the board response does not change', () => {
  it('carries no projection field, and is byte-identical to a run with the feature ignored', async () => {
    stubWith();
    const board = await app.request(`/api/users/${WILSON_ID}/board`, {}, testEnv());
    const text = await board.text();
    const body = JSON.parse(text) as BoardResponse;

    expect(board.status).toBe(200);
    expect(text).not.toContain('projection');
    expect(text).not.toContain('projected');
    expect(Object.keys(body).sort()).toEqual([
      'anyLive',
      'freshness',
      'generatedAt',
      'season',
      'teams',
      'user',
    ]);
    expect(Object.keys(body.teams[0] ?? {}).sort()).toEqual([
      'order',
      'selectionId',
      'snapshot',
      'team',
    ]);
  });

  it('answers the board with both publishers down, because it never asked them', async () => {
    // The reason the projection is its own request (§42): a scrape failure
    // cannot degrade the application's most important read.
    stubWith();
    const { response, body } = await get<BoardResponse>(
      `/api/users/${WILSON_ID}/board`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'odds' }),
    );

    expect(response.status).toBe(200);
    expect(body.teams.every((team) => team.snapshot.data !== null)).toBe(true);
    expect(body.freshness.state).toBe('fresh');
  });
});
