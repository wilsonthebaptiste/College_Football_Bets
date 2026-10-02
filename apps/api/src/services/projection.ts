import type {
  BoardProjectionResponse,
  BoardProjectionSummary,
  ConferenceStanding,
  Freshness,
  Points,
  ProjectedBoard,
  ProjectedTeam,
  ProjectedTeamEntry,
  ProjectedTerm,
  ProjectionInputName,
  ProjectionInputStatus,
  ProjectionInputs,
  ProjectionSource,
  ProjectionsResponse,
  RankingsSnapshot,
  Season,
  TeamIdentity,
  TeamProjection,
  UserTeamSelection,
} from '@cfb/shared';
import { formatPoints, projectBoard, projectTeam, unavailableFreshness } from '@cfb/shared';
import { cacheKey, policyFor } from '../cache/policy';
import type { CacheRead, CacheStatus } from '../cache/swr';
import type { PostgrestClient } from '../db/postgrest';
import { getUserWithSelections, listBoardsWithSelections } from '../db/queries';
import { HttpError } from '../http/errors';
import { isPowerFour } from '../providers/playoffstatus/conferences';
import type {
  ConferenceMap,
  ConferenceOddsDocument,
  TeamProjectionInputs,
  TeamProjectionsDocument,
} from '../providers/types';
import { resolveSeason } from '../season/resolve';
import type { Services } from './context';
import { composeFreshness } from './live';
import { readConferenceMap, readTeamListRead } from './search';
import { rankingOf, readRankings } from './snapshot';
import { teamNameKey } from './teamNames';

/**
 * The two documents projected points is computed from, and the join between
 * them (context/predicting_score.md, Phase 2).
 *
 * Nothing here applies the rubric — that is `packages/shared/src/scoring.ts`,
 * and it is pure. This module is the part that has to talk to two publishers,
 * two caches, and a team list, and it stops at producing the inputs.
 *
 * ## Why two reads and not one
 *
 * The documents have independent failure modes and the response must degrade
 * in labelled pieces: FPI down leaves the conference terms standing, the
 * scrape down leaves the national terms standing, and the screen says which
 * publisher each number came from (§42, §46). Fusing them into one cache entry
 * would make either failure take out both halves.
 */

/**
 * ESPN's FPI table, through the cache (6 h).
 *
 * Not season-scoped in the key, because the endpoint is not season-scoped: it
 * answers for whatever season ESPN is currently rating and stamps it with
 * `lastUpdated`. A season part in the key would promise a per-season document
 * that does not exist.
 */
export async function readProjectionInputs(
  services: Services,
): Promise<CacheRead<TeamProjectionsDocument>> {
  const { cache, provider } = services;
  return cache.read<TeamProjectionsDocument>({
    key: cacheKey('projection_inputs', provider.name),
    policyFor: () => policyFor('projection_inputs'),
    load: () => provider.getTeamProjections(),
  });
}

/**
 * The conference odds document, through its OWN cache (6 h).
 *
 * `services.oddsCache` rather than `services.cache`: freshness has to be
 * labelled with the publisher that produced it, and the sports provider did
 * not produce this. A conference term stamped `espn` would be the §46 mistake
 * at the envelope level.
 */
export async function readConferenceOdds(
  services: Services,
): Promise<CacheRead<ConferenceOddsDocument>> {
  const { oddsCache, oddsProvider } = services;
  const { season } = await resolveSeason(services);
  return oddsCache.read<ConferenceOddsDocument>({
    key: cacheKey('conference_odds', oddsProvider.name, String(season.year)),
    policyFor: () => policyFor('conference_odds'),
    load: () => oddsProvider.getConferenceOdds(season),
  });
}

// ─── The join ────────────────────────────────────────────────────────────────

export interface ConferenceOddsJoin {
  /** Provider team id → that team's odds. */
  byTeamId: Map<string, { winConference: number; reachConferenceGame: number }>;
  /**
   * Published rows that matched no team in the provider's list. Non-zero means
   * either a rename upstream or a missing alias, and either way some team's
   * conference term has silently gone `unavailable`.
   */
  unmatchedRows: string[];
  /**
   * Power-four teams in the conference map that no row covered. Non-zero means
   * a page lost a row — the failure mode a single regex over the table caused,
   * and the one the column sums alone would not always catch.
   */
  unmatchedTeams: string[];
}

/**
 * Published rows → provider team ids, reported in BOTH directions.
 *
 * Both directions matter and they fail differently. An unmatched row is a
 * name we could not resolve; an unmatched team is a row that was never there.
 * A caller that only checked one of them would miss half the ways this breaks.
 */
export function joinConferenceOdds(
  document: ConferenceOddsDocument,
  teams: readonly TeamIdentity[],
  conferences: ConferenceMap,
): ConferenceOddsJoin {
  const idByName = new Map<string, string>();
  for (const team of teams) {
    const key = teamNameKey(team.displayName ?? team.name);
    // First writer wins: the list is in the provider's order, and a later
    // duplicate of a name is not a better answer than the first.
    if (!idByName.has(key)) idByName.set(key, team.providerTeamId);
  }

  const byTeamId = new Map<string, { winConference: number; reachConferenceGame: number }>();
  const unmatchedRows: string[] = [];
  for (const row of document.rows) {
    const providerTeamId = idByName.get(teamNameKey(row.teamName));
    if (providerTeamId === undefined) {
      unmatchedRows.push(row.teamName);
      continue;
    }
    byTeamId.set(providerTeamId, {
      winConference: row.winConference,
      reachConferenceGame: row.reachConferenceGame,
    });
  }

  const unmatchedTeams: string[] = [];
  for (const [providerTeamId, conference] of Object.entries(conferences)) {
    if (!isPowerFour(conference)) continue;
    if (!byTeamId.has(providerTeamId)) unmatchedTeams.push(providerTeamId);
  }

  return { byTeamId, unmatchedRows, unmatchedTeams: unmatchedTeams.sort() };
}

// ─── Assembling one team's inputs ────────────────────────────────────────────

export interface ConferenceStandingArgs {
  providerTeamId: string;
  /** The team's conference short name, or `null` when the map could not be read. */
  conference: string | null;
  join: ConferenceOddsJoin | null;
  /** FPI's own figure, the labelled fallback when the scrape is gone. */
  fpiWinConference: number | null;
  /**
   * The label the odds publisher's own figures wear, and the label FPI's
   * fallback figure wears.
   *
   * Passed in rather than hard-coded, which is how Phase 2 had it. A hard-coded
   * `playoffstatus` labels the MOCK publisher's synthetic conference odds with
   * a real publisher's name — §46's mistake, in the one mode where every figure
   * is invented. Phase 3's routes made it visible, because they are the first
   * thing that puts a conference term's source on the wire.
   */
  oddsSource: ProjectionSource;
  fpiSource: ProjectionSource;
}

/**
 * One team's conference standing, in the three states §7's discipline requires.
 *
 * The order of these branches is the whole decision:
 *
 *   1. Not in the power four → `not_eligible`. A structural zero and a fact.
 *      Notre Dame genuinely cannot win a power-four conference, and that is
 *      different from a number we failed to load.
 *   2. The scrape resolved this team → `odds`, labelled `playoffstatus`.
 *   3. The scrape is gone but FPI published `probwinconf` → `odds`, labelled
 *      `espn_fpi`, with the CHAMPION figure only. FPI publishes no runner-up
 *      probability, so `reachConferenceGame` is set equal to it, which makes
 *      the runner-up term `max(0, e − d)` come out at exactly zero rather than
 *      inventing one. The two sources disagree by up to about 0.75 projected
 *      points per team, so this is a labelled substitute, never an average.
 *   4. Nothing → `unavailable`. Never a zero.
 *
 * A `null` conference — the map itself failed — is `unavailable` rather than
 * `not_eligible`: not knowing a team's conference is not the same as knowing
 * it is not in the power four.
 */
export function conferenceStandingFor(args: ConferenceStandingArgs): ConferenceStanding {
  if (args.conference !== null && !isPowerFour(args.conference)) return { kind: 'not_eligible' };

  const odds = args.join?.byTeamId.get(args.providerTeamId);
  if (odds !== undefined) {
    return {
      kind: 'odds',
      winConference: odds.winConference,
      reachConferenceGame: odds.reachConferenceGame,
      source: args.oddsSource,
    };
  }

  if (args.fpiWinConference !== null) {
    return {
      kind: 'odds',
      winConference: args.fpiWinConference,
      reachConferenceGame: args.fpiWinConference,
      source: args.fpiSource,
    };
  }

  return { kind: 'unavailable' };
}

/** FPI's figures for one team, or `null` when the publisher does not cover it. */
export function fpiInputsFor(
  document: TeamProjectionsDocument | null,
  providerTeamId: string,
): TeamProjectionInputs | null {
  return document?.teams.find((team) => team.providerTeamId === providerTeamId) ?? null;
}

// ─── Phase 3: the assembled answer ───────────────────────────────────────────
//
// `GET /api/projections` and `GET /api/users/:userId/projection`.
//
// Both are built from the same five reads and the selections, and NEITHER makes
// a per-team provider call: a nine-board leaderboard costs exactly the provider
// work one board costs. What differs is only how much of the result is kept —
// the leaderboard keeps nine totals, the board keeps six teams' rubric lines.

/** Everything both answers are assembled from, read once. */
export interface ProjectionSources {
  season: Season;
  fpi: TeamProjectionsDocument | null;
  join: ConferenceOddsJoin | null;
  /** `null` when the map could not be read, which is NOT the same as empty. */
  conferences: ConferenceMap | null;
  rankings: RankingsSnapshot | null;
  /**
   * The three labels, one per publisher, because mock mode must not wear a
   * publisher's name (§46) and a fallback must not wear the chosen source's:
   *
   *   `fpiSource`      FPI's three national figures, and its conference fallback
   *   `oddsSource`     the conference odds publisher's own figures
   *   `estimateSource` OUR Top-25 estimate, which reads the sports provider's poll
   */
  fpiSource: ProjectionSource;
  oddsSource: ProjectionSource;
  estimateSource: ProjectionSource;
  /** One entry per read, each with its own freshness and its publisher's own stamp. */
  sources: ProjectionInputStatus[];
  cacheStatus: CacheStatus;
}

/**
 * Which `ProjectionSource` each figure wears.
 *
 * Derived from the configured publisher rather than read back out of the
 * document, so that mock mode labels everything `mock_projection` (§46): a
 * synthetic number must not wear a real publisher's name, in any of the three
 * places a number comes from.
 */
function fpiSourceFor(services: Services): ProjectionSource {
  return services.provider.name === 'mock' ? 'mock_projection' : 'espn_fpi';
}

function oddsSourceFor(services: Services): ProjectionSource {
  return services.oddsProvider.name === 'playoffstatus' ? 'playoffstatus' : 'mock_projection';
}

/**
 * The label on the ONE quantity this application models: P(a team finishes in
 * the final Top 25).
 *
 * Deliberately not FPI's label, even though the estimate reads FPI's rank for
 * an unranked team. The whole licence for computing a sports number at all is
 * that this one is named as ours and nobody else's (§4, §46, and the three
 * conditions in `domain/projection.ts`). Labelling it `espn_fpi` would be
 * calling our own model an ESPN projection, which is §46's named example of
 * what not to do.
 */
function estimateSourceFor(services: Services): ProjectionSource {
  return services.provider.name === 'mock' ? 'mock_projection' : 'espn_poll_estimate';
}

function sourceEntry(
  input: ProjectionInputName,
  source: ProjectionSource | null,
  freshness: Freshness,
  computedLabel: string | null,
  pages: ProjectionInputStatus['pages'] = [],
): ProjectionInputStatus {
  return { input, source, freshness, computedLabel, pages };
}

/**
 * The five reads, in parallel, and the join between two of them.
 *
 * The season is resolved first because three of the reads are keyed by it. That
 * resolution is itself cached (6 h) and shared with every other read in the
 * application, so it is not a cost this feature adds — but it is why a cold run
 * writes KV three times for two documents rather than twice.
 */
export async function readProjectionSources(services: Services): Promise<ProjectionSources> {
  const { season } = await resolveSeason(services);

  const [fpiRead, oddsRead, rankingsRead, conferenceRead, teamsRead] = await Promise.all([
    readProjectionInputs(services),
    readConferenceOdds(services),
    readRankings(services, season),
    readConferenceMap(services),
    readTeamListRead(services),
  ]);

  const odds = oddsRead.envelope.data;
  const teams = teamsRead.envelope.data;
  const conferences = conferenceRead.envelope.data;

  // The join needs all three of the odds document, the team list, and the
  // conference map. Any one missing leaves it null, and a null join sends every
  // conference term to its fallback or to `unavailable` — never to a zero.
  const join =
    odds === null || teams === null || conferences === null
      ? null
      : joinConferenceOdds(odds, teams, conferences);
  if (join !== null && (join.unmatchedRows.length > 0 || join.unmatchedTeams.length > 0)) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'projection_join_incomplete',
        requestId: services.requestId,
        unmatchedRows: join.unmatchedRows,
        unmatchedTeams: join.unmatchedTeams,
      }),
    );
  }

  const fpiSource = fpiSourceFor(services);
  const oddsSource = oddsSourceFor(services);
  const estimateSource = estimateSourceFor(services);

  return {
    season,
    fpi: fpiRead.envelope.data,
    join,
    conferences,
    rankings: rankingsRead.envelope.data,
    fpiSource,
    oddsSource,
    estimateSource,
    sources: [
      sourceEntry(
        'fpi',
        fpiSource,
        fpiRead.envelope.freshness,
        fpiRead.envelope.data?.computedLabel ?? null,
      ),
      sourceEntry(
        'conference_odds',
        oddsSource,
        oddsRead.envelope.freshness,
        odds?.computedLabel ?? null,
        // Per conference, because the four pages do not agree on one stamp.
        (odds?.pages ?? []).map((page) => ({
          conference: page.conference,
          computedLabel: page.computedLabel,
        })),
      ),
      // The poll is quoted, but in this response it exists only as the input
      // to our own Top-25 estimate — so the label is the estimate's, the same
      // one every finish term carries. A screen reading this knows the number
      // derived from it is ours.
      sourceEntry('rankings', estimateSource, rankingsRead.envelope.freshness, null),
      // Identity, not a probability: no source label to carry (§45).
      sourceEntry('conferences', null, conferenceRead.envelope.freshness, null),
      sourceEntry('teams', null, teamsRead.envelope.freshness, null),
    ],
    cacheStatus: composeStatus([
      fpiRead.status,
      oddsRead.status,
      rankingsRead.status,
      conferenceRead.status,
      teamsRead.status,
    ]),
  };
}

/** `X-Cache` over the five reads: stale if any was, miss if any was fetched. */
function composeStatus(statuses: readonly CacheStatus[]): CacheStatus {
  if (statuses.includes('stale')) return 'stale';
  if (statuses.includes('miss') || statuses.includes('unavailable')) return 'miss';
  return 'hit';
}

/** The two publishers whose figures the rubric quotes; the rest are reference reads. */
const PRIMARY_INPUTS: readonly ProjectionInputName[] = ['fpi', 'conference_odds'];

/**
 * One `Freshness` for the whole response: the worst state and the oldest
 * timestamp of its parts (§23). Nothing on screen may look newer than its
 * oldest input.
 *
 * Two refinements over `composeFreshness`'s defaults, both for honesty:
 *
 *   - Only the two publishers are `primary`. The rankings, the conference map,
 *     and the team list are `reference`: they can degrade the state but must
 *     not drag the timestamp back, or a 24-hour conference map would make every
 *     projection look a day old (the same rule rankings already get on a card).
 *   - `composeFreshness` deliberately ignores an `unavailable` part, because on
 *     a board one failed card carries its own error. Here a failed publisher is
 *     half the rubric, so one of them down forces `stale` and BOTH down is
 *     `unavailable` — which is what stops a response that can say nothing from
 *     being cached as though it could.
 */
export function composeProjectionFreshness(
  services: Services,
  sources: readonly ProjectionInputStatus[],
): Freshness {
  const isPrimary = (entry: ProjectionInputStatus): boolean => PRIMARY_INPUTS.includes(entry.input);
  const primary = sources.filter(isPrimary).map((entry) => entry.freshness);
  const reference = sources.filter((entry) => !isPrimary(entry)).map((entry) => entry.freshness);

  if (primary.length > 0 && primary.every((part) => part.state === 'unavailable')) {
    return unavailableFreshness(services.provider.name, 0);
  }

  return composeFreshness({
    provider: services.provider.name,
    primary,
    reference,
    forceStale: sources.some((entry) => entry.freshness.state === 'unavailable'),
  });
}

/**
 * A cached composite repeats parts that were `fresh` when it was assembled.
 * They are now `cached`, or `stale` if the composite itself is. `fetchedAt` is
 * untouched either way (§39) — the same relabelling the board does to its cards.
 */
function relabel(entry: ProjectionInputStatus, state: 'cached' | 'stale'): ProjectionInputStatus {
  const { freshness } = entry;
  if (freshness.state === 'unavailable') return entry;
  if (state === 'cached' && freshness.state !== 'fresh') return entry;
  return { ...entry, freshness: { ...freshness, state, source: 'cache' } };
}

function relabelAll(
  sources: readonly ProjectionInputStatus[],
  status: CacheStatus,
): ProjectionInputStatus[] {
  if (status === 'hit') return sources.map((entry) => relabel(entry, 'cached'));
  if (status === 'stale') return sources.map((entry) => relabel(entry, 'stale'));
  return [...sources];
}

// ─── One team, from the sources ──────────────────────────────────────────────

/**
 * One team's `ProjectionInputs`.
 *
 * The one judgement here that is not Phase 2's: FPI's `probwinconf` is offered
 * as the champion-term fallback ONLY for a team we know is in the power four.
 * `conferenceStandingFor` cannot tell the difference on its own — given a
 * `null` conference it skips the eligibility branch — so a failed conference
 * map would otherwise pay a Mountain West team 3 points times its chance of
 * winning the Mountain West, which the rubric does not pay for at all. Not
 * knowing a team's conference means the conference terms are `unavailable`,
 * which is pessimistic and correct.
 */
export function projectionInputsFor(
  providerTeamId: string,
  sources: ProjectionSources,
): ProjectionInputs {
  const fpi = fpiInputsFor(sources.fpi, providerTeamId);
  const conference = sources.conferences?.[providerTeamId] ?? null;

  return {
    providerTeamId,
    fpi: fpi?.fpi ?? null,
    conference: conferenceStandingFor({
      providerTeamId,
      conference,
      join: sources.join,
      fpiWinConference: isPowerFour(conference) ? (fpi?.winConference ?? null) : null,
      oddsSource: sources.oddsSource,
      fpiSource: sources.fpiSource,
    }),
    ranking: rankingOf(providerTeamId, sources.rankings),
    estimateSource: sources.estimateSource,
  };
}

function projectSelections(
  selections: readonly UserTeamSelection[],
  sources: ProjectionSources,
): TeamProjection[] {
  return selections.map((selection) =>
    projectTeam(projectionInputsFor(selection.team.providerTeamId, sources), sources.season),
  );
}

/**
 * Anomalies are returned by the rubric, not logged by it: `packages/shared` is
 * pure and runs in the browser too. This is where they are recorded.
 *
 * Logged at assembly rather than per response, because the composite is cached
 * for two minutes: logging in the route would repeat the same anomaly on every
 * read of the same cached answer, which is noise, not signal.
 */
function logAnomalies(services: Services, projections: readonly TeamProjection[]): void {
  for (const projection of projections) {
    if (projection.anomalies.length === 0) continue;
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'projection_anomaly',
        requestId: services.requestId,
        team: projection.providerTeamId,
        anomalies: projection.anomalies,
      }),
    );
  }
}

// ─── The display edge ────────────────────────────────────────────────────────

/**
 * Rounding happens here and nowhere upstream: the service sums unrounded values
 * and this is the one place a points value becomes a string. Summing six
 * rounded numbers drifts — the plan's eight worked teams board 22.65 where
 * their rounded totals sum to 22.64.
 */
function pointsOf(value: number | null): Points | null {
  return value === null ? null : { value, display: formatPoints(value) };
}

function termOf(term: TeamProjection['terms'][number]): ProjectedTerm {
  return {
    kind: term.kind,
    state: term.state,
    points: term.points,
    probability: term.probability,
    contribution: pointsOf(term.contribution),
    source: term.source,
  };
}

function teamOf(projection: TeamProjection): ProjectedTeam {
  return {
    providerTeamId: projection.providerTeamId,
    terms: projection.terms.map(termOf),
    total: pointsOf(projection.total),
    complete: projection.complete,
  };
}

function boardOf(projections: readonly TeamProjection[]): ProjectedBoard {
  const board = projectBoard(projections);
  return {
    total: pointsOf(board.total),
    teamsCounted: board.teamsCounted,
    teamsTotal: board.teamsTotal,
  };
}

// ─── GET /api/users/:userId/projection ───────────────────────────────────────

interface BoardComposite {
  user: { id: string; displayName: string };
  season: Season;
  sources: ProjectionInputStatus[];
  board: ProjectedBoard;
  teams: ProjectedTeamEntry[];
}

export interface BoardProjectionResult {
  body: BoardProjectionResponse;
  cacheStatus: CacheStatus;
}

async function assembleBoard(
  services: Services,
  db: PostgrestClient,
  userId: string,
): Promise<BoardComposite> {
  const [{ user, selections }, sources] = await Promise.all([
    getUserWithSelections(db, userId),
    readProjectionSources(services),
  ]);

  const projections = projectSelections(selections, sources);
  logAnomalies(services, projections);

  return {
    user,
    season: sources.season,
    sources: sources.sources,
    board: boardOf(projections),
    teams: selections.map((selection, index) => ({
      selectionId: selection.id,
      order: selection.order,
      team: selection.team,
      // `projections` is built from `selections` in order, so the index lines up.
      projection: teamOf(projections[index]!),
    })),
  };
}

export async function getBoardProjection(
  services: Services,
  db: PostgrestClient,
  userId: string,
): Promise<BoardProjectionResult> {
  const read = await services.cache.read<BoardComposite>({
    key: cacheKey('projection_board', services.provider.name, userId),
    policyFor: () => policyFor('projection_board'),
    load: () => assembleBoard(services, db, userId),
    // A projection for a user who does not exist is a 404, never a stale copy.
    isFatal: (error) => error instanceof HttpError && error.kind === 'not_found',
    // Without the selections there is no projection at all, so a database
    // failure keeps its own status and message rather than becoming an empty
    // 200. Both publishers failing is a different thing entirely: that is a
    // 200 whose every term is `unavailable`.
    whenUnavailable: 'throw',
  });

  const composite = read.envelope.data;
  if (composite === null) throw new HttpError('internal', 'Unable to load this projection.');

  const sources = relabelAll(composite.sources, read.status);
  return {
    body: {
      user: composite.user,
      season: composite.season,
      generatedAt: new Date(services.now()).toISOString(),
      freshness: composeProjectionFreshness(services, sources),
      sources,
      board: composite.board,
      teams: composite.teams,
    },
    cacheStatus: reportedStatus(sources, read.status),
  };
}

// ─── GET /api/projections ────────────────────────────────────────────────────

interface LeaderboardComposite {
  season: Season;
  sources: ProjectionInputStatus[];
  boards: BoardProjectionSummary[];
}

export interface ProjectionsResult {
  body: ProjectionsResponse;
  cacheStatus: CacheStatus;
}

/**
 * Highest projected total first, then display name.
 *
 * A board with no total at all sorts last whatever its name: it is not a zero,
 * and putting it among the low scores would read as one. Nothing here calls
 * anybody the winner — it is a projection, and ties to 2 dp will happen.
 */
function byProjectedTotal(a: BoardProjectionSummary, b: BoardProjectionSummary): number {
  if (a.total === null || b.total === null) {
    if (a.total !== null) return -1;
    if (b.total !== null) return 1;
    return a.displayName.localeCompare(b.displayName);
  }
  return b.total.value - a.total.value || a.displayName.localeCompare(b.displayName);
}

async function assembleLeaderboard(
  services: Services,
  db: PostgrestClient,
): Promise<LeaderboardComposite> {
  const [boards, sources] = await Promise.all([
    listBoardsWithSelections(db),
    readProjectionSources(services),
  ]);

  const summaries = boards.map(({ user, selections }) => {
    const projections = projectSelections(selections, sources);
    logAnomalies(services, projections);
    const board = boardOf(projections);
    return {
      userId: user.id,
      displayName: user.displayName,
      total: board.total,
      teamsCounted: board.teamsCounted,
      teamsTotal: board.teamsTotal,
    };
  });

  return {
    season: sources.season,
    sources: sources.sources,
    boards: summaries.sort(byProjectedTotal),
  };
}

export async function getAllProjections(
  services: Services,
  db: PostgrestClient,
): Promise<ProjectionsResult> {
  const read = await services.cache.read<LeaderboardComposite>({
    key: cacheKey('projection_board', services.provider.name, 'all'),
    policyFor: () => policyFor('projection_board'),
    load: () => assembleLeaderboard(services, db),
    whenUnavailable: 'throw',
  });

  const composite = read.envelope.data;
  if (composite === null) throw new HttpError('internal', 'Unable to load projections.');

  const sources = relabelAll(composite.sources, read.status);
  return {
    body: {
      season: composite.season,
      generatedAt: new Date(services.now()).toISOString(),
      freshness: composeProjectionFreshness(services, sources),
      sources,
      boards: composite.boards,
    },
    cacheStatus: reportedStatus(sources, read.status),
  };
}

/**
 * `X-Cache` describes what the response is made of, not only where the
 * composite came from: a freshly assembled answer whose publishers fell back to
 * stale data is a stale response.
 */
function reportedStatus(
  sources: readonly ProjectionInputStatus[],
  status: CacheStatus,
): CacheStatus {
  return sources.some((entry) => entry.freshness.state === 'stale') ? 'stale' : status;
}
