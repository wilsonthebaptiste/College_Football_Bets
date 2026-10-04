import type {
  AppError,
  BoardResponse,
  BoardTeam,
  Envelope,
  Freshness,
  FreshnessState,
  Game,
  GameDetail,
  GameDetailResponse,
  Matchup,
  MatchupBoardResponse,
  MatchupOwner,
  MatchupResponse,
  MatchupSide,
  NextGameSlot,
  PageTeam,
  Prediction,
  PredictionResponse,
  RankingState,
  ScheduleItem,
  Team,
  TeamDetailResponse,
  TeamIdentity,
  TeamOwner,
  TeamOwnersResponse,
  TeamRecord,
  TeamScheduleResponse,
  TeamSearchResponse,
  TeamSnapshot,
  BoardProjectionResponse,
  BoardProjectionSummary,
  OutcomeKind,
  Points,
  ProjectedTeam,
  ProjectedTeamEntry,
  ProjectedTerm,
  ProjectionInputName,
  ProjectionInputStatus,
  ProjectionSource,
  ProjectionsResponse,
  TeamProjectionResponse,
} from '@cfb/shared';
import { formatPoints as formatSharedPoints, OUTCOME_ORDER, RUBRIC } from '@cfb/shared';

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

/** `PageTeam`, so a team with no row of ours (`id: null`) has a snapshot too. */
export function makeSnapshot(team: PageTeam, overrides: Partial<TeamSnapshot> = {}): TeamSnapshot {
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

/** `PageTeam`, not `Team`: a team with no row of ours has a page too, with `id: null`. */
export function teamDetail(
  team: PageTeam,
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
  team: PageTeam,
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

// ─── Search (plan-search-engine, Phase 3) ───────────────────────────────────

/**
 * A team as the SEARCH route returns it: the provider's identity, with no uuid
 * of ours at all. Most of the country is this, not a board team — 762 teams
 * are listed and 54 sit on boards.
 */
export function makeIdentity(overrides: Partial<TeamIdentity> = {}): TeamIdentity {
  const { id: _id, ...identity } = makeTeam();
  return { ...identity, ...overrides };
}

/**
 * Mercer, and what an FCS school genuinely looks like coming back from the
 * provider: no conference (the map is FBS-only) and, for 12% of the list, no
 * logo either. Both render as existing vocabulary, never as an invention (§4).
 */
export function fcsIdentity(overrides: Partial<TeamIdentity> = {}): TeamIdentity {
  return makeIdentity({
    provider: 'espn',
    providerTeamId: '2382',
    name: 'Mercer Bears',
    displayName: 'Mercer',
    abbreviation: 'MER',
    logoUrl: null,
    conference: null,
    primaryColor: null,
    altColor: null,
    ...overrides,
  });
}

export function searchResponse(teams: TeamIdentity[]): TeamSearchResponse {
  return { teams };
}

// ─── The pick index (plan-search-engine, Part Two) ──────────────────────────

/** Someone whose board holds a team. The uuid is what `/u/:userId` addresses. */
export function makeOwner(displayName: string, userId: string = nextId()): TeamOwner {
  return { userId, displayName };
}

/**
 * `GET /api/selections` as the browser sees it: provider team id → who has that
 * team. A team nobody picked is ABSENT, never an empty array — the shape the
 * page relies on to render no line at all.
 */
export function ownersResponse(owners: Record<string, TeamOwner[]>): TeamOwnersResponse {
  return { owners };
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

// ─── Projected points (predicting_score.md, Phase 4) ────────────────────────

/** The six lines' contributions, in rubric order: `5a, 4(b−a), 3c, 3d, 2(e−d), 2p−1`. */
export type Contributions = [number, number, number, number | null, number | null, number];

function points(value: number): Points {
  return { value, display: formatSharedPoints(value) };
}

/**
 * One projected team, built from its six contributions the way the plan's
 * worked table prints them. `null` in a conference slot means not eligible
 * (a structural zero); `unavailable` lists the lines nobody could quote.
 */
export function projectedTeam(
  contributions: Contributions,
  options: {
    unavailable?: readonly OutcomeKind[];
    conferenceSource?: ProjectionSource;
    total?: number;
  } = {},
): ProjectedTeam {
  const unavailable = new Set(options.unavailable ?? []);
  const sources: Record<OutcomeKind, ProjectionSource> = {
    national_champion: 'espn_fpi',
    national_runner_up: 'espn_fpi',
    playoff: 'espn_fpi',
    conference_champion: options.conferenceSource ?? 'playoffstatus',
    conference_runner_up: options.conferenceSource ?? 'playoffstatus',
    final_ranking: 'espn_poll_estimate',
  };
  const terms: ProjectedTerm[] = OUTCOME_ORDER.map((kind, index) => {
    const value = contributions[index] ?? null;
    const base = { kind, points: RUBRIC[kind] };
    if (unavailable.has(kind)) {
      return { ...base, state: 'unavailable', probability: null, contribution: null, source: null };
    }
    if (value === null) {
      return {
        ...base,
        state: 'not_eligible',
        probability: null,
        contribution: points(0),
        source: null,
      };
    }
    const probability = kind === 'final_ranking' ? (value + 1) / 2 : value / RUBRIC[kind];
    return {
      ...base,
      state: 'known',
      probability,
      contribution: points(value),
      source: sources[kind],
    };
  });
  // The rubric's rule: a total needs a publisher's figure, not only our estimate.
  const known = terms.filter((term) => term.state === 'known' && term.kind !== 'final_ranking');
  const sum = terms.reduce((total, term) => total + (term.contribution?.value ?? 0), 0);
  return {
    providerTeamId: '333',
    terms,
    total: known.length === 0 ? null : points(options.total ?? sum),
    complete: terms.every((term) => term.state !== 'unavailable'),
  };
}

/** A team nobody publishes about: six dashes and no total. */
export function unprojectedTeam(): ProjectedTeam {
  return projectedTeam([0, 0, 0, 0, 0, 0], { unavailable: OUTCOME_ORDER });
}

/** The two playoffstatus stamps of 2026-09-30, which the four pages split between. */
export const SEC_STAMP = 'Sat Sep 26 11:30 pm';
export const BIG_TEN_STAMP = 'Sun Sep 27 2:45 am';

type SourceOverrides = Partial<Record<ProjectionInputName, Partial<ProjectionInputStatus>>>;

/**
 * The five inputs as the real publishers answer them: FPI's daily instant, and
 * four conference pages that do not agree on one stamp, so the document-level
 * one is null (Phase 2).
 */
export function projectionSources(overrides: SourceOverrides = {}): ProjectionInputStatus[] {
  const entry = (
    input: ProjectionInputName,
    source: ProjectionSource | null,
    computedLabel: string | null = null,
    pages: ProjectionInputStatus['pages'] = [],
  ): ProjectionInputStatus => ({
    input,
    source,
    freshness: freshness('cached'),
    computedLabel,
    pages,
    error: null,
    ...overrides[input],
  });
  return [
    entry('fpi', 'espn_fpi', '2026-09-30T08:00Z'),
    entry('conference_odds', 'playoffstatus', null, [
      { conference: 'SEC', computedLabel: SEC_STAMP },
      { conference: 'Big Ten', computedLabel: BIG_TEN_STAMP },
      { conference: 'Big 12', computedLabel: SEC_STAMP },
      { conference: 'ACC', computedLabel: BIG_TEN_STAMP },
    ]),
    entry('rankings', 'espn_poll_estimate'),
    entry('conferences', null),
    entry('teams', null),
  ];
}

/**
 * An input that could not be read at all, carrying the reference its failure
 * was logged under — as every failed read in a request does.
 */
export function inputDown(
  requestId: string | null = 'req-input-down',
): Partial<ProjectionInputStatus> {
  return {
    freshness: freshness('unavailable'),
    computedLabel: null,
    pages: [],
    error: {
      kind: 'provider_unavailable',
      message: 'Sports data temporarily unavailable.',
      requestId,
    },
  };
}

/**
 * The plan's eight worked teams of 2026-09-30, as printed. Their rounded
 * totals sum to 22.64; the board, summed unrounded and rounded once, is 22.65.
 */
export const WORKED_TEAMS: ReadonlyArray<[string, Contributions, number]> = [
  ['Texas', [0.73, 0.49, 2.68, 0.57, 0.34, 0.93], 5.7312],
  ['Miami', [0.51, 0.38, 2.56, 0.66, 0.4, 0.85], 5.3687],
  ['Georgia', [0.79, 0.48, 2.52, 0.33, 0.24, 0.9], 5.2611],
  ['Notre Dame', [0.71, 0.46, 2.54, null, null, 0.88], 4.5904],
  ['Boise State', [0.01, 0.02, 1.01, null, null, 0.41], 1.4506],
  ['Nebraska', [0.04, 0.06, 0.77, 0.33, 0.22, -0.19], 1.2311],
  ['Texas A&M', [0.01, 0.01, 0.09, 0.01, 0, -0.19], -0.0689],
  ['Kansas', [0, 0, 0, 0.01, 0, -0.93], -0.9172],
];

export function projectedEntry(
  name: string,
  projection: ProjectedTeam,
  order = 1,
): ProjectedTeamEntry {
  return {
    selectionId: nextId(),
    order,
    team: makeTeam({ displayName: name, name: `${name} Full Name` }),
    projection,
  };
}

export function boardProjection(
  teams: ProjectedTeamEntry[],
  overrides: Partial<BoardProjectionResponse> = {},
): BoardProjectionResponse {
  const counted = teams.filter((entry) => entry.projection.total !== null);
  const sum = counted.reduce((total, entry) => total + (entry.projection.total?.value ?? 0), 0);
  return {
    user: { id: nextId(), displayName: 'Wilson' },
    season: SEASON,
    generatedAt: '2026-10-01T18:00:00.000Z',
    freshness: freshness('cached'),
    sources: projectionSources(),
    board: {
      total: counted.length === 0 ? null : points(sum),
      teamsCounted: counted.length,
      teamsTotal: teams.length,
    },
    teams,
    ...overrides,
  };
}

export function teamProjection(
  team: PageTeam,
  projection: ProjectedTeam,
  sources: ProjectionInputStatus[] = projectionSources(),
): TeamProjectionResponse {
  return {
    team,
    season: SEASON,
    generatedAt: '2026-10-01T18:00:00.000Z',
    freshness: freshness('cached'),
    sources,
    projection,
  };
}

export function projectionsResponse(
  boards: BoardProjectionSummary[],
  sources: ProjectionInputStatus[] = projectionSources(),
): ProjectionsResponse {
  return {
    season: SEASON,
    generatedAt: '2026-10-01T18:00:00.000Z',
    freshness: freshness('cached'),
    sources,
    boards,
  };
}

export function boardSummary(
  userId: string,
  displayName: string,
  total: number | null,
  teamsCounted = 6,
  teamsTotal = 6,
): BoardProjectionSummary {
  return {
    userId,
    displayName,
    total: total === null ? null : points(total),
    teamsCounted,
    teamsTotal,
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

// ─── The matchup board (plan-matchup-board, Phase 2) ─────────────────────────

/** The longest team name the provider lists, for "nothing scrolls sideways". */
export const LONGEST_NAME = 'Louisiana-Monroe Warhawks of Northeast Louisiana';

export function makeMatchupOwner(displayName: string, userId: string = nextId()): MatchupOwner {
  return { userId, displayName };
}

export const WILSON = makeMatchupOwner('Wilson', '22222222-2222-4222-8222-000000000001');
export const STEPH = makeMatchupOwner('Steph', '22222222-2222-4222-8222-000000000002');
export const JORDAN = makeMatchupOwner('Jordan', '22222222-2222-4222-8222-000000000003');

export function makeMatchupSide(overrides: Partial<MatchupSide> = {}): MatchupSide {
  return {
    team: makeTeam(),
    owners: [STEPH],
    ranking: RANKED,
    record: RECORD,
    score: null,
    winner: null,
    ...overrides,
  };
}

/**
 * An ordinary upcoming matchup: Ohio State (Wilson's) at Iowa (Steph's),
 * Saturday 3:30 PM Eastern, on FOX.
 */
export function makeMatchup(overrides: Partial<Matchup> = {}): Matchup {
  return {
    providerGameId: '401500001',
    season: { year: 2026, type: 'regular', week: 6 },
    week: 6,
    kickoffUtc: '2026-10-10T19:30:00.000Z',
    kickoffTbd: false,
    status: 'scheduled',
    statusDetail: null,
    period: null,
    clock: null,
    neutralSite: false,
    venue: 'Kinnick Stadium',
    broadcast: 'FOX',
    away: makeMatchupSide({
      team: makeTeam({
        providerTeamId: '194',
        name: 'Ohio State Buckeyes',
        displayName: 'Ohio State',
        abbreviation: 'OSU',
        conference: 'Big Ten',
      }),
      owners: [WILSON],
      ranking: { kind: 'ranked', rank: 2, poll: 'AP Top 25', week: 6 },
      record: { ...RECORD, summary: '5-0' },
    }),
    home: makeMatchupSide({
      team: makeTeam({
        providerTeamId: '2294',
        name: 'Iowa Hawkeyes',
        displayName: 'Iowa',
        abbreviation: 'IOWA',
        conference: 'Big Ten',
      }),
      owners: [STEPH],
      ranking: { kind: 'unranked' },
      record: { ...RECORD, summary: '3-2' },
    }),
    situation: null,
    sameOwner: false,
    scoreUpdatedAt: '2026-10-10T17:59:00.000Z',
    freshness: freshness('fresh', '2026-10-10T17:59:00.000Z'),
    ...overrides,
  };
}

/** In the 2nd quarter, Ohio State up 14–7, the score read at 9:41 PM UTC. */
export function liveMatchup(overrides: Partial<Matchup> = {}): Matchup {
  const base = makeMatchup();
  return makeMatchup({
    providerGameId: '401500002',
    status: 'live',
    statusDetail: '4:32 - 2nd Quarter',
    period: 2,
    clock: '4:32',
    away: { ...base.away, score: 14 },
    home: { ...base.home, score: 7 },
    scoreUpdatedAt: '2026-10-10T21:41:00.000Z',
    freshness: freshness('fresh', '2026-10-10T21:41:00.000Z'),
    ...overrides,
  });
}

/** Final: Ohio State 31, Iowa 24. */
export function finalMatchup(overrides: Partial<Matchup> = {}): Matchup {
  const base = makeMatchup();
  return makeMatchup({
    providerGameId: '401500003',
    kickoffUtc: '2026-10-09T00:00:00.000Z',
    status: 'final',
    statusDetail: 'Final',
    away: { ...base.away, score: 31, winner: true },
    home: { ...base.home, score: 24, winner: false },
    ...overrides,
  });
}

export function matchupBoardResponse(
  matchups: Matchup[],
  overrides: Partial<MatchupBoardResponse> = {},
): MatchupBoardResponse {
  return {
    season: { year: 2026, type: 'regular', week: 6 },
    week: 6,
    weeks: [
      {
        week: 5,
        label: 'Week 5',
        startUtc: '2026-09-29T07:00:00Z',
        endUtc: '2026-10-06T06:59:00Z',
      },
      {
        week: 6,
        label: 'Week 6',
        startUtc: '2026-10-06T07:00:00Z',
        endUtc: '2026-10-13T06:59:00Z',
      },
      {
        week: 7,
        label: 'Week 7',
        startUtc: '2026-10-13T07:00:00Z',
        endUtc: '2026-10-20T06:59:00Z',
      },
    ],
    generatedAt: '2026-10-10T18:00:00.000Z',
    freshness: freshness('fresh', '2026-10-10T17:59:00.000Z'),
    error: null,
    anyLive: matchups.some((row) => row.status === 'live'),
    notice: null,
    matchups,
    ...overrides,
  };
}

export function matchupResponse(matchup: Matchup): MatchupResponse {
  return {
    season: matchup.season,
    generatedAt: '2026-10-10T18:00:00.000Z',
    matchup,
  };
}

// ─── Inside the game (plan-matchup-board, Phase 3) ───────────────────────────

/** Ohio State (away) has the ball, 2nd & 7 at the Iowa 34. */
export const LIVE_SITUATION = {
  possessionTeamId: '194',
  downDistance: '2nd & 7 at IOWA 34',
  lastPlay: '(4:40) C. Kurtz pass complete to J. Smith for 9 yards',
};

const stat = (display: string | null, value: number | null = null) => ({ display, value });

/** The live game's inside: 2nd quarter, Ohio State 14, Iowa 7, read at 9:41 PM UTC. */
export function liveGameDetail(overrides: Partial<GameDetail> = {}): GameDetail {
  return {
    providerGameId: '401500002',
    status: 'live',
    kickoffUtc: '2026-10-10T19:30:00.000Z',
    kickoffTbd: false,
    lineScore: {
      periods: [
        { number: 1, label: '1', home: 7, away: 7 },
        { number: 2, label: '2', home: 0, away: 7 },
      ],
      homeTotal: 7,
      awayTotal: 14,
    },
    statsKind: 'game',
    teamStats: [
      { key: 'firstDowns', label: '1st Downs', home: stat('8', 8), away: stat('11', 11) },
      { key: 'thirdDownEff', label: '3rd down efficiency', home: stat('2-6'), away: stat('4-7') },
      { key: 'totalYards', label: 'Total Yards', home: stat('142'), away: stat('231') },
      // ESPN sends "-" where a number was expected: no number, and the string is kept.
      { key: 'fourthDownEff', label: '4th down efficiency', home: stat('0-0'), away: stat(null) },
      {
        key: 'possessionTime',
        label: 'Possession',
        home: stat('11:02', 662),
        away: stat('12:28', 748),
      },
    ],
    leaders: [
      {
        category: 'passing',
        label: 'Passing',
        home: { name: 'Mark Gronowski', line: '7/12, 88 YDS' },
        away: { name: 'Julian Sayin', line: '12/16, 151 YDS, 2 TD' },
      },
      {
        category: 'rushing',
        label: 'Rushing',
        home: { name: 'Kamari Moulton', line: '9 CAR, 41 YDS, 1 TD' },
        away: null,
      },
      {
        category: 'receiving',
        label: 'Receiving',
        home: { name: 'Reece Vander Zee', line: '3 REC, 40 YDS' },
        away: { name: 'Jeremiah Smith', line: '5 REC, 77 YDS, 1 TD' },
      },
    ],
    scoringPlays: [
      {
        id: 'sp1',
        period: 1,
        clock: '9:12',
        teamId: '194',
        kind: 'TD',
        text: 'Jeremiah Smith 22 Yd pass from Julian Sayin (Jayden Fielding Kick)',
        homeScore: 0,
        awayScore: 7,
      },
      {
        id: 'sp2',
        period: 1,
        clock: '2:01',
        teamId: '2294',
        kind: 'TD',
        text: 'Kamari Moulton 3 Yd Run (Drew Stevens Kick)',
        homeScore: 7,
        awayScore: 7,
      },
      {
        id: 'sp3',
        period: 2,
        clock: '6:30',
        teamId: '194',
        kind: 'TD',
        text: 'Carnell Tate 15 Yd pass from Julian Sayin (Jayden Fielding Kick)',
        homeScore: 7,
        awayScore: 14,
      },
    ],
    currentDrive: { teamId: '194', description: '6 plays, 41 yards, 2:51' },
    winProbability: {
      source: 'espn_win_probability',
      sourceLabel: 'ESPN win probability',
      homeWinProbability: 0.214,
      awayWinProbability: 0.786,
      tieProbability: 0,
      homeSeries: [0.38, 0.31, 0.44, 0.29, 0.214],
    },
    ...overrides,
  };
}

/** Before kickoff: season averages and season leaders, nothing else. */
export function upcomingGameDetail(overrides: Partial<GameDetail> = {}): GameDetail {
  return liveGameDetail({
    providerGameId: '401500001',
    status: 'scheduled',
    lineScore: null,
    statsKind: 'season_average',
    teamStats: [
      {
        key: 'totalPointsPerGame',
        label: 'Points Per Game',
        home: stat('24.2'),
        away: stat('41.6'),
      },
      { key: 'yardsPerGame', label: 'Total Yards', home: stat('331.0'), away: stat('488.4') },
    ],
    scoringPlays: [],
    currentDrive: null,
    winProbability: null,
    ...overrides,
  });
}

/** Final: Ohio State 31, Iowa 24. No win probability of any kind. */
export function finalGameDetail(overrides: Partial<GameDetail> = {}): GameDetail {
  return liveGameDetail({
    providerGameId: '401500003',
    status: 'final',
    lineScore: {
      periods: [
        { number: 1, label: '1', home: 7, away: 7 },
        { number: 2, label: '2', home: 3, away: 10 },
        { number: 3, label: '3', home: 7, away: 7 },
        { number: 4, label: '4', home: 7, away: 7 },
      ],
      homeTotal: 24,
      awayTotal: 31,
    },
    currentDrive: null,
    winProbability: null,
    ...overrides,
  });
}

export function gameDetailResponse(
  detail: GameDetail | null,
  state: FreshnessState = 'fresh',
  error: AppError | null = null,
  fetchedAt = '2026-10-10T21:40:30.000Z',
): GameDetailResponse {
  return {
    detail: {
      data: detail,
      freshness: detail === null ? freshness('unavailable') : freshness(state, fetchedAt),
      error,
    },
  };
}
