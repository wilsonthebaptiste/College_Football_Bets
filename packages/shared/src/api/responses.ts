import type { AppError, Envelope, Freshness, SportsProviderName } from '../envelope';
import type { Season, SeasonSource } from '../season';
import type {
  Game,
  OutcomeKind,
  PageTeam,
  Prediction,
  ProjectionSource,
  ProjectionTermState,
  ScheduleResult,
  Team,
  TeamSnapshot,
  UserSummary,
  UserTeamSelection,
} from '../domain';

/**
 * The §8 API contract, typed once and imported by both sides of the wire.
 *
 * Every response that contains provider-owned data carries `Freshness` — either
 * as an `Envelope<T>` or as a sibling field. Application-owned data (users,
 * selections, team identity) does not: it comes from our own Postgres and is
 * either there or a 404.
 */

// ─── GET /api/health ─────────────────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok';
  version: string;
  /** The configured sports provider. The odds publisher is not a sports provider. */
  provider: SportsProviderName;
  season: Season;
  seasonSource: SeasonSource;
  cache: {
    /**
     * Result of a real write-then-read probe of the Cache API, run once per
     * isolate. False on `workers.dev`, where `caches.default` exists but stores
     * nothing. Informational: no code path depends on L2.
     */
    l2Available: boolean;
    kvWrites: KvWriteReport;
  };
}

/**
 * KV writes made by THIS isolate today (plan §7: the free tier allows roughly
 * 1,000 writes a day). Each isolate counts only its own, so this is a floor on
 * the account-wide figure, not the total. The dashboard has the real number.
 */
export interface KvWriteReport {
  /** UTC day the counts belong to, `YYYY-MM-DD`. */
  day: string;
  total: number;
  byCategory: Record<string, number>;
  /** Writes skipped because the daily hard cap was reached. */
  refused: number;
}

// ─── GET /api/meta/season ────────────────────────────────────────────────────

export interface SeasonMetaResponse {
  season: Envelope<Season>;
  source: SeasonSource;
}

// ─── GET /api/users ──────────────────────────────────────────────────────────

export interface UsersResponse {
  users: UserSummary[];
}

// ─── GET /api/users/:userId ──────────────────────────────────────────────────

/** Identity only. No records, ranks, or scores — that is what the board is for. */
export interface UserDetailResponse {
  user: { id: string; displayName: string };
  selections: UserTeamSelection[];
}

// ─── GET /api/users/:userId/board ────────────────────────────────────────────

export interface BoardTeam {
  selectionId: string;
  order: number;
  /** Application-owned, always present. A failed snapshot still renders a card (§42). */
  team: Team;
  /** Provider-owned. May be `{ data: null, error }` while siblings are fine (§38). */
  snapshot: Envelope<TeamSnapshot>;
}

export interface BoardResponse {
  user: { id: string; displayName: string };
  season: Season;
  generatedAt: string;
  /** Freshness of the board composite itself, not of any one team. */
  freshness: Freshness;
  /** §24 — drives the client's polling interval. Derived, never client-guessed. */
  anyLive: boolean;
  teams: BoardTeam[];
}

// ─── GET /api/selections ─────────────────────────────────────────────────────

/** Someone whose board holds a team. `userId` addresses `/u/:userId`. */
export interface TeamOwner {
  userId: string;
  displayName: string;
}

/**
 * Every board's picks, inverted: PROVIDER team id → who has that team, sorted
 * by display name. Keyed by the provider's id because that is the id a search
 * result carries and the one id both team-page addresses share; our uuid exists
 * only for a team we store. A team nobody picked is absent, not an empty array.
 */
export interface TeamOwnersResponse {
  owners: Record<string, TeamOwner[]>;
}

// ─── GET /api/teams/:teamId ──────────────────────────────────────────────────

/**
 * `:teamId` is either our own uuid or the provider's team id, so any team the
 * provider lists has a page. `team.id` is therefore our uuid only for a team we
 * store — a team somebody has put on a board — and `null` for every other.
 */
export interface TeamDetailResponse {
  team: PageTeam;
  season: Season;
  snapshot: Envelope<TeamSnapshot>;
}

// ─── GET /api/teams/:teamId/schedule ─────────────────────────────────────────

/** `team.id`, as above: our uuid only for a team we store. */
export interface TeamScheduleResponse {
  team: PageTeam;
  schedule: Envelope<ScheduleResult>;
}

// ─── GET /api/games/:gameId ──────────────────────────────────────────────────

export interface GameResponse {
  game: Envelope<Game>;
}

// ─── GET /api/games/:gameId/prediction ───────────────────────────────────────

/**
 * `data: null` with `error: null` is the "Prediction unavailable" case and is a
 * completely normal 200 (§12). Nothing here ever synthesizes a percentage.
 */
export interface PredictionResponse {
  prediction: Envelope<Prediction | null>;
}

// ─── GET /api/projections, GET /api/users/:userId/projection ─────────────────

/**
 * A points value as the wire carries it: the unrounded number for arithmetic,
 * and the 2-dp string for display.
 *
 * Both, deliberately. Rounding happens once, at this edge (the route), and the
 * string travels with the number so that two clients cannot round the same
 * value differently in the last digit. A client that sums should sum `value`
 * and format the result; a client that prints should print `display`.
 */
export interface Points {
  value: number;
  display: string;
}

/**
 * The reads a projection is assembled from. Each fails on its own (§42), and
 * the response names every one of them so that nothing degrades invisibly.
 *
 * `teams` is the provider's team list. It carries no probability — it is what
 * resolves the odds publisher's own team spellings to provider team ids, so
 * losing it costs the conference terms their quoted source even when the
 * scrape itself is fine.
 */
export type ProjectionInputName = 'fpi' | 'conference_odds' | 'rankings' | 'conferences' | 'teams';

/**
 * One conference page's own stamp, verbatim.
 *
 * Per page rather than per document because the four pages are recomputed in
 * batches and do not agree: two said "Sat Sep 26 11:30 pm" while the other two
 * said "Sun Sep 27 2:45 am". Ordering two such strings needs a year and a
 * timezone the publisher does not give, so a team's conference term is dated by
 * its OWN conference's page and nothing picks between them.
 */
export interface ProjectionPageStamp {
  conference: string;
  computedLabel: string | null;
}

/**
 * One input to a projection, with its own freshness and its publisher's own
 * stamp — which is the number a screen should show, not our read time (§39).
 *
 * `source` is `null` only when the input publishes no figure of its own (the
 * conference map, which is identity rather than a probability).
 */
export interface ProjectionInputStatus {
  input: ProjectionInputName;
  source: ProjectionSource | null;
  freshness: Freshness;
  /** The publisher's own stamp, verbatim and never parsed. */
  computedLabel: string | null;
  /**
   * Conference odds only, and empty for every other input: the per-conference
   * stamps. `computedLabel` above is non-null only when all four agree, which
   * on real data is the exceptional case rather than the normal one.
   */
  pages: ProjectionPageStamp[];
}

/**
 * One rubric line on the wire. `state` keeps §7's three-state discipline: a
 * value, a structural zero (`0.00` with a reason), or "we do not know" (`—`).
 *
 * `contribution` is authoritative and must be rendered as given. It is NOT
 * `points × probability` for the final-ranking line, where a team finishes in
 * exactly one of two paid states and the contribution is the whole expectation
 * `2p − 1`. Recomputing it would drop the rubric's −1 line.
 */
export interface ProjectedTerm {
  kind: OutcomeKind;
  state: ProjectionTermState;
  points: number;
  /** 0–1, the publisher's own number. `null` unless `state === 'known'`. */
  probability: number | null;
  /** `null` when the term is unavailable; `0.00` when the team is not eligible. */
  contribution: Points | null;
  source: ProjectionSource | null;
}

export interface ProjectedTeam {
  providerTeamId: string;
  /** One entry per `OutcomeKind`, in rubric order. */
  terms: ProjectedTerm[];
  /** `null` when no term is known — never a confident `0.00`. */
  total: Points | null;
  /** True when no term is `unavailable`, i.e. the total is the whole rubric. */
  complete: boolean;
}

/** One row of the breakdown: the board's team, and its projection. */
export interface ProjectedTeamEntry {
  selectionId: string;
  order: number;
  /** Application-owned identity, always present, exactly as the board carries it. */
  team: Team;
  projection: ProjectedTeam;
}

export interface ProjectedBoard {
  /** The sum of the teams' unrounded totals, rounded once. `null` when none has one. */
  total: Points | null;
  /** So a screen says "5 of 6 teams" rather than treating the sixth as zero. */
  teamsCounted: number;
  teamsTotal: number;
}

/** One person's line on the leaderboard. No team breakdown — that is its own read. */
export interface BoardProjectionSummary {
  userId: string;
  displayName: string;
  total: Points | null;
  teamsCounted: number;
  teamsTotal: number;
}

/**
 * Every board's projected total, in one request.
 *
 * Sorted by total descending, then by display name, so a tie to 2 dp is still
 * a stable order. Nobody is labelled "winning": it is a projection, and ties
 * will happen.
 */
export interface ProjectionsResponse {
  season: Season;
  generatedAt: string;
  /** The worst state and oldest timestamp of the inputs (§23). Never newer than its parts. */
  freshness: Freshness;
  sources: ProjectionInputStatus[];
  boards: BoardProjectionSummary[];
}

/** One board's projection, with every team's rubric lines. */
export interface BoardProjectionResponse {
  user: { id: string; displayName: string };
  season: Season;
  generatedAt: string;
  freshness: Freshness;
  sources: ProjectionInputStatus[];
  board: ProjectedBoard;
  teams: ProjectedTeamEntry[];
}

// ─── GET /api/teams/:teamId/projection ───────────────────────────────────────

/**
 * One team's rubric lines, for the team page (Phase 4).
 *
 * `:teamId` is either of a team's two addresses, exactly as on the team route,
 * so any team the provider lists has one — on a board or not. A team no
 * publisher covers (most of the ~762) is a normal 200 whose total is `null`.
 */
export interface TeamProjectionResponse {
  team: PageTeam;
  season: Season;
  generatedAt: string;
  freshness: Freshness;
  sources: ProjectionInputStatus[];
  projection: ProjectedTeam;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** The body of every non-2xx response from this API. */
export interface ApiErrorBody {
  error: AppError;
}
