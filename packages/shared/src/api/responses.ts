import type { AppError, Envelope, Freshness, ProviderName } from '../envelope';
import type { Season, SeasonSource } from '../season';
import type {
  Game,
  PageTeam,
  Prediction,
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
  provider: ProviderName;
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

// ─── Errors ──────────────────────────────────────────────────────────────────

/** The body of every non-2xx response from this API. */
export interface ApiErrorBody {
  error: AppError;
}
