import type {
  AppError,
  BoardResponse,
  BoardTeam,
  Envelope,
  Freshness,
  FreshnessState,
  Game,
  NextGameSlot,
  RankingState,
  Team,
  TeamRecord,
  TeamSnapshot,
} from '@cfb/shared';

/**
 * Builders for the board payload, shaped exactly like `packages/shared`'s
 * contract. Each test states only what differs from an ordinary mid-season
 * card: Alabama, #4, 4-0, beat LSU, Tennessee next.
 */

export const NOW = Date.parse('2026-10-01T18:00:00Z');

let seq = 0;
const nextId = (): string => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
};

export function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: nextId(),
    provider: 'mock',
    providerTeamId: '333',
    name: 'Alabama Crimson Tide',
    displayName: 'Alabama',
    abbreviation: 'ALA',
    logoUrl: 'https://example.test/logos/333.png',
    conference: 'SEC',
    primaryColor: '9e1b32',
    altColor: 'ffffff',
    ...overrides,
  };
}

export function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    providerGameId: '401000001',
    season: { year: 2026, type: 'regular', week: 5 },
    week: 5,
    kickoffUtc: '2026-10-03T20:30:00.000Z',
    kickoffTbd: false,
    status: 'scheduled',
    statusDetail: null,
    period: null,
    clock: null,
    homeAway: 'away',
    opponent: {
      providerTeamId: '2633',
      name: 'Tennessee',
      abbreviation: 'TENN',
      logoUrl: null,
    },
    teamScore: null,
    opponentScore: null,
    result: null,
    venue: 'Neyland Stadium',
    broadcast: 'CBS',
    ...overrides,
  };
}

export function finalGame(overrides: Partial<Game> = {}): Game {
  return makeGame({
    providerGameId: '401000000',
    week: 4,
    kickoffUtc: '2026-09-26T23:00:00.000Z',
    status: 'final',
    statusDetail: 'Final',
    homeAway: 'home',
    opponent: { providerTeamId: '99', name: 'LSU', abbreviation: 'LSU', logoUrl: null },
    teamScore: 31,
    opponentScore: 24,
    result: 'W',
    ...overrides,
  });
}

export function liveGame(overrides: Partial<Game> = {}): Game {
  return makeGame({
    providerGameId: '401000002',
    kickoffUtc: '2026-10-01T16:30:00.000Z',
    status: 'live',
    statusDetail: '4:32 - 3rd Quarter',
    period: 3,
    clock: '4:32',
    teamScore: 24,
    opponentScore: 21,
    ...overrides,
  });
}

export const RECORD: TeamRecord = {
  wins: 4,
  losses: 0,
  ties: null,
  summary: '4-0',
  conference: { wins: 2, losses: 0 },
};

export const RANKED: RankingState = { kind: 'ranked', rank: 4, poll: 'AP Top 25', week: 5 };

export function makeSnapshot(team: Team, overrides: Partial<TeamSnapshot> = {}): TeamSnapshot {
  const { id: _id, ...identity } = team;
  const nextGame: NextGameSlot = { kind: 'game', game: makeGame() };
  return {
    identity,
    record: RECORD,
    ranking: RANKED,
    previousGame: finalGame(),
    nextGame,
    liveGame: null,
    ...overrides,
  };
}

export function freshness(
  state: FreshnessState,
  fetchedAt: string | null = '2026-10-01T17:59:30.000Z',
): Freshness {
  return {
    state,
    fetchedAt: state === 'unavailable' ? null : fetchedAt,
    ttlSeconds: 60,
    expiresAt: null,
    source: state === 'fresh' ? 'provider' : state === 'unavailable' ? 'none' : 'cache',
    provider: 'mock',
  };
}

export function envelope(
  data: TeamSnapshot | null,
  state: FreshnessState = 'fresh',
  error: AppError | null = null,
  fetchedAt?: string,
): Envelope<TeamSnapshot> {
  return { data, freshness: freshness(state, fetchedAt), error };
}

export function makeBoardTeam(
  snapshot: Envelope<TeamSnapshot>,
  team: Team = makeTeam(),
  order = 1,
): BoardTeam {
  return { selectionId: nextId(), order, team, snapshot };
}

export function makeBoard(
  teams: BoardTeam[],
  overrides: Partial<BoardResponse> = {},
): BoardResponse {
  return {
    user: { id: nextId(), displayName: 'Wilson' },
    season: { year: 2026, type: 'regular', week: 5 },
    generatedAt: '2026-10-01T18:00:00.000Z',
    freshness: freshness('fresh'),
    anyLive: teams.some((entry) => entry.snapshot.data?.liveGame != null),
    teams,
    ...overrides,
  };
}

export const PROVIDER_DOWN: AppError = {
  kind: 'provider_unavailable',
  message: 'Sports data temporarily unavailable.',
  requestId: 'req-123',
};
