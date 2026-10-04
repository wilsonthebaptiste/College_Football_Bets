import type {
  AppError,
  Freshness,
  GameStatus,
  Matchup,
  MatchupBoardNotice,
  MatchupBoardResponse,
  MatchupOwner,
  MatchupResponse,
  MatchupSide,
  PageTeam,
  RankingsSnapshot,
  Season,
  SeasonWeek,
  SportsProviderName,
} from '@cfb/shared';
import { seasonKey } from '@cfb/shared';
import { cacheKey, policyFor } from '../cache/policy';
import type { CacheRead, CacheStatus } from '../cache/swr';
import type { PostgrestClient } from '../db/postgrest';
import { listBoardsWithSelections, type UserWithSelections } from '../db/queries';
import { HttpError, invalidRequest } from '../http/errors';
import type { ProviderCompetitor, ProviderGame } from '../providers/types';
import { ProviderError } from '../providers/types';
import { resolveSeason } from '../season/resolve';
import type { Services } from './context';
import { readProviderGame } from './games';
import { composeCacheStatus, composeFreshness, overlayLive, type LiveOverlay } from './live';
import { rankingOf, readRankings } from './snapshot';

/**
 * The matchup board (context/plan-matchup-board.md, Phase 1): every game in a
 * week where a team on one board plays a team on another.
 *
 *   week games  → who plays whom, kickoff, records    (15 min, one request)
 *   live slate  → status, score, clock while live     (25 s, the boards' own key)
 *   rankings    → rank                                (1 h, the boards' own read)
 *   Postgres    → who has each side, team identity    (one query, every board)
 *
 * Nothing is stored (§45): a matchup is derived on every assembly, and the
 * assembled answer lives 60 s in L1 (15 s while live or degraded), never in
 * KV. An admin write drops it (`routes/admin.ts`).
 *
 * The picks are required. Without them there is no matchup to show, so a
 * database failure is the response's error rather than an empty board. The
 * provider reads are not: a week that cannot be read is a 200 that says so,
 * with the reference it was logged under (§38, §42).
 */

// ─── Reads ───────────────────────────────────────────────────────────────────

/** The season phase's weeks, on the calendar's own cache schedule (6 h). */
export function readSeasonWeeks(
  services: Services,
  season: Season,
): Promise<CacheRead<SeasonWeek[]>> {
  const { cache, provider } = services;
  return cache.read({
    key: cacheKey('season_calendar', provider.name, seasonKey(season), 'weeks'),
    policyFor: () => policyFor('season_calendar'),
    load: () => provider.getSeasonWeeks(season),
  });
}

/** Over, and will not change again: a canceled game is as settled as a final. */
function isSettled(game: ProviderGame): boolean {
  return game.status === 'final' || game.status === 'canceled';
}

/**
 * One week's games, normalized before they are cached. A week whose every
 * game is settled is kept for a day: a past week does not change.
 */
export function readWeekGames(
  services: Services,
  season: Season,
  week: number,
): Promise<CacheRead<ProviderGame[]>> {
  const { cache, provider } = services;
  return cache.read({
    key: cacheKey('week', provider.name, seasonKey(season), String(week)),
    policyFor: (games) =>
      policyFor('week_games', { weekComplete: games.length > 0 && games.every(isSettled) }),
    load: () => provider.getWeekGames(season, week),
  });
}

// ─── Which week ──────────────────────────────────────────────────────────────

/**
 * The week the board opens on, when the request names none.
 *
 * The season resolution's own week first, when the calendar lists it. Then the
 * week whose window holds `now`. Between weeks, before the first, or after the
 * last, the nearest one: a Tuesday shows the coming Saturday's games, and the
 * day after the last bowl still shows the last bowls rather than nothing.
 */
export function defaultWeek(season: Season, weeks: readonly SeasonWeek[], now: number): number {
  const first = weeks[0];
  if (first === undefined) throw new Error('defaultWeek needs at least one week');
  if (season.week !== null && weeks.some((entry) => entry.week === season.week)) {
    return season.week;
  }
  const containing = weeks.find(
    (entry) => Date.parse(entry.startUtc) <= now && now <= Date.parse(entry.endUtc),
  );
  if (containing !== undefined) return containing.week;
  const next = weeks.find((entry) => Date.parse(entry.startUtc) > now);
  return (next ?? weeks.at(-1) ?? first).week;
}

type WeekChoice = { week: number; notice: null } | { week: null; notice: MatchupBoardNotice };

/**
 * `requested` is the parsed `?week=`. A week the calendar does not list is the
 * caller's mistake (400). With the calendar unreadable, a requested week is
 * taken on trust — the week read itself will say if it is nonsense — and the
 * season's own week is the default, when it has one.
 */
function chooseWeek(
  season: Season,
  weeks: CacheRead<SeasonWeek[]>,
  requested: number | null,
  now: number,
): WeekChoice {
  const listed = weeks.envelope.data;
  if (listed === null) {
    const week = requested ?? season.week;
    return week === null ? { week: null, notice: 'week_unknown' } : { week, notice: null };
  }
  if (requested !== null) {
    if (!listed.some((entry) => entry.week === requested)) {
      throw invalidRequest(`There is no week ${String(requested)} in this season's calendar.`);
    }
    return { week: requested, notice: null };
  }
  if (listed.length === 0) return { week: null, notice: 'offseason' };
  return { week: defaultWeek(season, listed, now), notice: null };
}

// ─── Who has each side ───────────────────────────────────────────────────────

interface PickIndex {
  /** Provider team id → its owners, sorted by display name. */
  owners: Map<string, MatchupOwner[]>;
  /** Provider team id → the stored team, for identity (§45). */
  teams: Map<string, PageTeam>;
}

/**
 * Every board's picks, inverted, from the same one-query read the leaderboard
 * uses. Only teams stored under the provider's own id space count, as in the
 * pick index (`toTeamOwners`): a row from another namespace is some other
 * provider's team with a coincidentally equal id.
 */
export function indexPicks(
  boards: readonly UserWithSelections[],
  namespace: SportsProviderName,
): PickIndex {
  const owners = new Map<string, MatchupOwner[]>();
  const teams = new Map<string, PageTeam>();
  for (const { user, selections } of boards) {
    for (const { team } of selections) {
      if (team.provider !== namespace) continue;
      const list = owners.get(team.providerTeamId) ?? [];
      if (!list.some((owner) => owner.userId === user.id)) {
        list.push({ userId: user.id, displayName: user.displayName });
      }
      owners.set(team.providerTeamId, list);
      teams.set(team.providerTeamId, {
        id: team.id,
        provider: team.provider,
        providerTeamId: team.providerTeamId,
        name: team.name,
        displayName: team.displayName,
        abbreviation: team.abbreviation,
        logoUrl: team.logoUrl,
        conference: team.conference,
        primaryColor: team.primaryColor,
        altColor: team.altColor,
      });
    }
  }
  for (const list of owners.values()) {
    list.sort(
      (a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId),
    );
  }
  return { owners, teams };
}

/** Both sides are on at least one board. A game one person has both sides of still counts. */
export function isMatchup(game: ProviderGame, picks: PickIndex): boolean {
  return (
    picks.owners.has(game.home.team.providerTeamId) &&
    picks.owners.has(game.away.team.providerTeamId)
  );
}

// ─── One row ─────────────────────────────────────────────────────────────────

interface RowContext {
  picks: PickIndex;
  namespace: SportsProviderName;
  rankings: RankingsSnapshot | null;
  rankingsFreshness: Freshness;
  /** The freshness of what the games were read from: the week document, or the one game. */
  baseFreshness: Freshness;
  overlay: LiveOverlay;
  provider: Services['provider'];
}

/**
 * The provider's own identity, for a side nobody has. Only the single-game
 * read can reach this: on the board both sides are stored by definition.
 */
function providerIdentity(competitor: ProviderCompetitor, namespace: SportsProviderName): PageTeam {
  const { team } = competitor;
  return {
    id: null,
    provider: namespace,
    providerTeamId: team.providerTeamId,
    name: team.name,
    displayName: team.name,
    abbreviation: team.abbreviation,
    logoUrl: team.logoUrl,
    conference: null,
    primaryColor: null,
    altColor: null,
  };
}

function sideOf(competitor: ProviderCompetitor, context: RowContext): MatchupSide {
  const id = competitor.team.providerTeamId;
  return {
    team: context.picks.teams.get(id) ?? providerIdentity(competitor, context.namespace),
    owners: context.picks.owners.get(id) ?? [],
    ranking: rankingOf(id, context.rankings),
    record: competitor.record,
    score: competitor.score,
    winner: competitor.winner,
  };
}

function rowOf(game: ProviderGame, context: RowContext): Matchup {
  const home = sideOf(game.home, context);
  const away = sideOf(game.away, context);
  const homeOwners = new Set(home.owners.map((owner) => owner.userId));
  const slate = context.overlay.overlaidFreshness.get(game.providerGameId);

  // A row whose live game came off the slate is as old as that slate read:
  // its status, score, clock, and records are all the slate's. The week
  // document behind it can still make it stale, but not older.
  const freshness = composeFreshness({
    provider: context.provider.name,
    primary: [slate ?? context.baseFreshness],
    reference:
      slate === undefined
        ? [context.rankingsFreshness]
        : [context.baseFreshness, context.rankingsFreshness],
    forceStale: context.overlay.unverified.has(game.providerGameId),
  });

  return {
    providerGameId: game.providerGameId,
    season: game.season,
    week: game.week,
    kickoffUtc: game.kickoffUtc,
    kickoffTbd: game.kickoffTbd,
    status: game.status,
    statusDetail: game.statusDetail,
    period: game.period,
    clock: game.clock,
    neutralSite: game.neutralSite,
    venue: game.venue,
    broadcast: game.broadcast,
    home,
    away,
    // Only from a slate laid over this row. A row the slate could not check
    // shows no situation rather than whatever the week document last had.
    situation: slate === undefined ? null : (game.situation ?? null),
    sameOwner: away.owners.some((owner) => homeOwners.has(owner.userId)),
    scoreUpdatedAt:
      context.overlay.overlaidAt.get(game.providerGameId) ?? context.baseFreshness.fetchedAt,
    freshness,
  };
}

// ─── Order (§51: what is happening now, first) ───────────────────────────────

/** Kicked off and not over, including a mid-game delay. */
function inProgress(status: GameStatus, period: number | null): boolean {
  if (status === 'live') return true;
  return (status === 'delayed' || status === 'suspended') && period !== null;
}

function sectionOf(row: Matchup): number {
  if (inProgress(row.status, row.period)) return 0;
  if (row.status === 'final') return 2;
  if (row.status === 'postponed' || row.status === 'canceled') return 3;
  return 1;
}

/**
 * Live, then upcoming by kickoff with a TBD kickoff last within its day, then
 * finals, then postponed and canceled. The day is the provider's slate day
 * (US Eastern for ESPN), never the UTC date: a Saturday-night kickoff is
 * stamped Sunday in UTC. The client regroups by the viewer's own zone.
 */
export function compareRows(slateKeyFor: (kickoffUtc: string) => string) {
  return (a: Matchup, b: Matchup): number => {
    const section = sectionOf(a) - sectionOf(b);
    if (section !== 0) return section;
    if (sectionOf(a) === 1) {
      const day = slateKeyFor(a.kickoffUtc).localeCompare(slateKeyFor(b.kickoffUtc));
      if (day !== 0) return day;
      if (a.kickoffTbd !== b.kickoffTbd) return a.kickoffTbd ? 1 : -1;
    }
    return (
      a.kickoffUtc.localeCompare(b.kickoffUtc) || a.providerGameId.localeCompare(b.providerGameId)
    );
  };
}

// ─── Relabelling a cached answer ─────────────────────────────────────────────

/**
 * A composite served from its own cache repeats rows that were `fresh` when
 * assembled. They are now `cached`, or `stale` if the composite is. As on the
 * board, `fetchedAt` is untouched either way (§39).
 */
function relabel(freshness: Freshness, status: CacheStatus): Freshness {
  if (freshness.state === 'unavailable') return freshness;
  if (status === 'hit' && freshness.state === 'fresh') {
    return { ...freshness, state: 'cached', source: 'cache' };
  }
  if (status === 'stale') return { ...freshness, state: 'stale', source: 'cache' };
  return freshness;
}

function relabelRow(row: Matchup, status: CacheStatus): Matchup {
  const freshness = relabel(row.freshness, status);
  return freshness === row.freshness ? row : { ...row, freshness };
}

const isDegradedState = (freshness: Freshness): boolean =>
  freshness.state === 'stale' || freshness.state === 'unavailable';

/** A composite's own cache answer, unless something inside it is stale. */
function reportedStatus(status: CacheStatus, freshness: readonly Freshness[]): CacheStatus {
  return freshness.some((part) => part.state === 'stale') ? 'stale' : status;
}

/** Postgres's "no such user" never reaches here; any 404 inside a composite is a real one. */
const isNotFound = (error: unknown): boolean =>
  (error instanceof HttpError && error.kind === 'not_found') ||
  (error instanceof ProviderError && error.kind === 'not_found');

// ─── GET /api/matchups?week= ─────────────────────────────────────────────────

interface BoardComposite {
  freshness: Freshness;
  error: AppError | null;
  anyLive: boolean;
  matchups: Matchup[];
  /** The provider reads behind it, for `X-Cache` on the request that assembled it. */
  statuses: CacheStatus[];
}

export interface MatchupBoardResult {
  body: MatchupBoardResponse;
  cacheStatus: CacheStatus;
  /** Some row, or the week as a whole, is stale or unavailable: keep the response short-lived. */
  degraded: boolean;
  /** The composite's own freshness: how long this answer is good for. */
  composite: Freshness | null;
}

async function assembleBoard(
  services: Services,
  db: PostgrestClient,
  season: Season,
  week: number,
): Promise<BoardComposite> {
  const [boards, weekRead, rankings] = await Promise.all([
    listBoardsWithSelections(db),
    readWeekGames(services, season, week),
    readRankings(services, season),
  ]);
  const statuses = [weekRead.status, rankings.status];

  const games = weekRead.envelope.data;
  if (games === null) {
    return {
      freshness: weekRead.envelope.freshness,
      error: weekRead.envelope.error,
      anyLive: false,
      matchups: [],
      statuses,
    };
  }

  const picks = indexPicks(boards, services.provider.teamNamespace);
  const weekFreshness = weekRead.envelope.freshness;
  const overlay = await overlayLive(
    services,
    games.filter((game) => isMatchup(game, picks)),
    weekFreshness.fetchedAt,
  );

  const context: RowContext = {
    picks,
    namespace: services.provider.teamNamespace,
    rankings: rankings.envelope.data,
    rankingsFreshness: rankings.envelope.freshness,
    baseFreshness: weekFreshness,
    overlay,
    provider: services.provider,
  };
  const matchups = overlay.games
    .map((game) => rowOf(game, context))
    .sort(compareRows((kickoff) => services.provider.slateKeyFor(kickoff)));

  return {
    freshness: composeFreshness({
      provider: services.provider.name,
      primary: [weekFreshness],
      reference: [rankings.envelope.freshness],
      forceStale: matchups.some((row) => row.freshness.state === 'stale'),
    }),
    error: null,
    anyLive: matchups.some((row) => inProgress(row.status, row.period)),
    matchups,
    statuses: [...statuses, ...overlay.slates.map((slate) => slate.status)],
  };
}

function isBoardDegraded(composite: BoardComposite): boolean {
  return (
    isDegradedState(composite.freshness) ||
    composite.matchups.some((row) => isDegradedState(row.freshness))
  );
}

export async function getMatchupBoard(
  services: Services,
  db: PostgrestClient,
  requestedWeek: number | null,
): Promise<MatchupBoardResult> {
  const { season } = await resolveSeason(services);
  const weeksRead = await readSeasonWeeks(services, season);
  const weeks = weeksRead.envelope.data ?? [];
  const choice = chooseWeek(season, weeksRead, requestedWeek, services.now());
  const generatedAt = new Date(services.now()).toISOString();

  if (choice.week === null) {
    // Nothing to assemble, so no database read: an offseason board costs one
    // cached calendar read. Its freshness is the calendar's, which is what
    // the notice is a statement about.
    return {
      body: {
        season,
        week: null,
        weeks,
        generatedAt,
        freshness: weeksRead.envelope.freshness,
        error: weeksRead.envelope.error,
        anyLive: false,
        notice: choice.notice,
        matchups: [],
      },
      cacheStatus: weeksRead.status,
      degraded: isDegradedState(weeksRead.envelope.freshness),
      composite: null,
    };
  }

  const week = choice.week;
  const read = await services.cache.read<BoardComposite>({
    key: cacheKey('matchups', services.provider.name, seasonKey(season), String(week)),
    policyFor: (composite) =>
      policyFor('matchup_composite', {
        anyLive: composite.anyLive,
        degraded: isBoardDegraded(composite),
      }),
    load: () => assembleBoard(services, db, season, week),
    isFatal: isNotFound,
    // Without the picks there is no matchup at all, so a database failure
    // keeps its own status and message rather than becoming an empty 200.
    whenUnavailable: 'throw',
  });

  const composite = read.envelope.data;
  if (composite === null) throw new HttpError('internal', 'Unable to load the matchups.');

  const matchups = composite.matchups.map((row) => relabelRow(row, read.status));
  const freshness = relabel(composite.freshness, read.status);
  const status = read.status === 'miss' ? composeCacheStatus(composite.statuses) : read.status;

  return {
    body: {
      season,
      week,
      weeks,
      generatedAt,
      freshness,
      error: composite.error,
      anyLive: composite.anyLive,
      notice: null,
      matchups,
    },
    cacheStatus: reportedStatus(status, [freshness, ...matchups.map((row) => row.freshness)]),
    degraded: isDegradedState(freshness) || matchups.some((row) => isDegradedState(row.freshness)),
    composite: read.envelope.freshness,
  };
}

// ─── GET /api/matchups/:gameId ───────────────────────────────────────────────

interface GameComposite {
  season: Season;
  matchup: Matchup;
  anyLive: boolean;
  statuses: CacheStatus[];
}

export interface MatchupResult {
  body: MatchupResponse;
  cacheStatus: CacheStatus;
  degraded: boolean;
  composite: Freshness;
}

async function assembleGame(
  services: Services,
  db: PostgrestClient,
  providerGameId: string,
): Promise<GameComposite> {
  const [boards, gameRead, { season }] = await Promise.all([
    listBoardsWithSelections(db),
    // The game IS this response: with nothing cached and the provider down,
    // the provider's error is the answer (503), and "no such game" is a 404.
    readProviderGame(services, providerGameId, { whenUnavailable: 'throw' }),
    resolveSeason(services),
  ]);
  const game = gameRead.envelope.data;
  if (game === null) throw new HttpError('internal', 'Unable to load this game.');

  const rankings = await readRankings(services, season);
  const gameFreshness = gameRead.envelope.freshness;
  const overlay = await overlayLive(services, [game], gameFreshness.fetchedAt);
  const live = overlay.games[0] ?? game;

  const matchup = rowOf(live, {
    picks: indexPicks(boards, services.provider.teamNamespace),
    namespace: services.provider.teamNamespace,
    rankings: rankings.envelope.data,
    rankingsFreshness: rankings.envelope.freshness,
    baseFreshness: gameFreshness,
    overlay,
    provider: services.provider,
  });

  return {
    season,
    matchup,
    anyLive: inProgress(matchup.status, matchup.period),
    statuses: [gameRead.status, rankings.status, ...overlay.slates.map((slate) => slate.status)],
  };
}

export async function getMatchup(
  services: Services,
  db: PostgrestClient,
  providerGameId: string,
): Promise<MatchupResult> {
  const read = await services.cache.read<GameComposite>({
    key: cacheKey('matchups', services.provider.name, 'game', providerGameId),
    policyFor: (composite) =>
      policyFor('matchup_composite', {
        anyLive: composite.anyLive,
        degraded: isDegradedState(composite.matchup.freshness),
      }),
    load: () => assembleGame(services, db, providerGameId),
    isFatal: isNotFound,
    whenUnavailable: 'throw',
  });

  const composite = read.envelope.data;
  if (composite === null) throw new HttpError('internal', 'Unable to load this game.');

  const matchup = relabelRow(composite.matchup, read.status);
  const status = read.status === 'miss' ? composeCacheStatus(composite.statuses) : read.status;
  return {
    body: {
      season: composite.season,
      generatedAt: new Date(services.now()).toISOString(),
      matchup,
    },
    cacheStatus: reportedStatus(status, [matchup.freshness]),
    degraded: isDegradedState(matchup.freshness),
    composite: read.envelope.freshness,
  };
}
