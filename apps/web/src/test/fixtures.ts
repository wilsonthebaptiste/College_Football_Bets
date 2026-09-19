import type {
  AppError,
  BoardResponse,
  BoardTeam,
  Envelope,
  Freshness,
  FreshnessState,
  Game,
  NextGameSlot,
  Prediction,
  PredictionResponse,
  RankingState,
  ScheduleItem,
  Team,
  TeamDetailResponse,
  TeamRecord,
  TeamScheduleResponse,
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
    liveUpdatedAt: null,
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

// ─── The team page's other two reads (§12, §17) ─────────────────────────────

export const SEASON = { year: 2026, type: 'regular', week: 5 } as const;

export function teamDetail(
  team: Team,
  snapshot: Envelope<TeamSnapshot>,
  season: TeamDetailResponse['season'] = SEASON,
): TeamDetailResponse {
  return { team, season, snapshot };
}

/**
 * Alabama's season to date, from the card's point of view: a win, a tie, a
 * loss, a bye, a canceled game, the next game (Tennessee), a postponement,
 * and a TBD kickoff at the end.
 */
export function seasonItems(): ScheduleItem[] {
  const opponent = (providerTeamId: string, name: string, abbreviation: string) => ({
    providerTeamId,
    name,
    abbreviation,
    logoUrl: null,
  });
  const games: Game[] = [
    finalGame({
      providerGameId: 'g1',
      week: 1,
      kickoffUtc: '2026-09-05T23:00:00.000Z',
      opponent: opponent('2', 'Auburn', 'AUB'),
      teamScore: 34,
      opponentScore: 17,
      result: 'W',
      statusDetail: 'Final/OT',
    }),
    finalGame({
      providerGameId: 'g2',
      week: 2,
      kickoffUtc: '2026-09-12T19:30:00.000Z',
      homeAway: 'away',
      opponent: opponent('57', 'Florida', 'FLA'),
      teamScore: 20,
      opponentScore: 24,
      result: 'L',
      venue: 'Ben Hill Griffin Stadium',
    }),
    finalGame({
      providerGameId: 'g3',
      week: 3,
      kickoffUtc: '2026-09-19T16:00:00.000Z',
      homeAway: 'neutral',
      opponent: opponent('145', 'Ole Miss', 'MISS'),
      teamScore: 17,
      opponentScore: 17,
      result: 'T',
      venue: 'Neutral Site Stadium',
    }),
    makeGame({
      providerGameId: 'g4',
      week: 4,
      kickoffUtc: '2026-09-26T16:00:00.000Z',
      homeAway: 'home',
      opponent: opponent('238', 'Vanderbilt', 'VAN'),
      status: 'canceled',
      statusDetail: 'Canceled',
      venue: 'Bryant-Denny Stadium',
    }),
    makeGame({ providerGameId: '401000001' }), // week 5: Tennessee, next
    makeGame({
      providerGameId: 'g7',
      week: 7,
      kickoffUtc: '2026-10-17T19:30:00.000Z',
      homeAway: 'home',
      opponent: opponent('99', 'LSU', 'LSU'),
      status: 'postponed',
      statusDetail: 'Postponed',
      venue: 'Bryant-Denny Stadium',
      broadcast: null,
    }),
    makeGame({
      providerGameId: 'g8',
      week: 8,
      kickoffUtc: '2026-10-24T04:00:00.000Z',
      kickoffTbd: true,
      homeAway: 'away',
      opponent: opponent('201', 'Oklahoma', 'OU'),
      venue: null,
      broadcast: null,
    }),
  ];
  const [w1, w2, w3, w4, w5, w7, w8] = games as [Game, Game, Game, Game, Game, Game, Game];
  const game = (entry: Game): ScheduleItem => ({ kind: 'game', game: entry });
  return [
    game(w1),
    game(w2),
    game(w3),
    game(w4),
    game(w5),
    { kind: 'bye', week: 6 },
    game(w7),
    game(w8),
  ];
}

export function scheduleResponse(
  team: Team,
  items: ScheduleItem[] = seasonItems(),
  state: FreshnessState = 'fresh',
  error: AppError | null = null,
): TeamScheduleResponse {
  return {
    team,
    schedule: {
      data: state === 'unavailable' ? null : { season: SEASON, items },
      freshness: freshness(state),
      error,
    },
  };
}

export function makePrediction(overrides: Partial<Prediction> = {}): Prediction {
  return {
    source: 'espn_matchup_predictor',
    sourceLabel: 'ESPN matchup predictor',
    providerGameId: '401000001',
    homeWinPct: 33,
    awayWinPct: 67,
    // Alabama is away at Tennessee in `makeGame`, so Alabama is the away side.
    home: { providerTeamId: '2633', name: 'Tennessee Volunteers', abbreviation: 'TENN' },
    away: { providerTeamId: '333', name: 'Alabama Crimson Tide', abbreviation: 'ALA' },
    retrievedAt: '2026-10-01T17:30:00.000Z',
    ...overrides,
  };
}

export function predictionResponse(
  prediction: Prediction | null,
  state: FreshnessState = 'fresh',
  error: AppError | null = null,
): PredictionResponse {
  return {
    prediction: {
      data: prediction,
      // "The provider has none" is a normal, fresh answer; only a failure is `unavailable`.
      freshness: freshness(state),
      error,
    },
  };
}
