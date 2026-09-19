import type {
  AppErrorKind,
  GameStatus,
  Prediction,
  ProviderName,
  RankingsSnapshot,
  Season,
  TeamIdentity,
  TeamRecord,
  TeamRef,
} from '@cfb/shared';

/**
 * The sports-data provider contract (§5).
 *
 * Everything a provider returns is already normalized: no ESPN field name, URL,
 * or status string crosses this boundary. Swapping providers means writing a
 * sibling of `espn/` that satisfies this interface and adding one line to
 * `registry.ts`. Nothing in `services/`, `routes/`, or the web app changes.
 *
 * Two rules every implementation follows (plan §6):
 *   - Failure THROWS a `ProviderError`. The cache layer turns throws into
 *     `stale` or `unavailable` envelopes; a provider never knows about caching
 *     or freshness.
 *   - Legitimate absence RETURNS `null` (no predictor published, no poll for
 *     this season). Absence is data, not an error.
 *
 * Where this departs from plan §6, and why:
 *   - `getTeamSnapshot` is gone. A snapshot fuses data with different lifetimes
 *     (schedule 15 min, rankings 1 h, live score 25 s), so it cannot be one
 *     cache entry with one TTL. The provider returns the pieces;
 *     `services/snapshot.ts` assembles them, the same way for every provider.
 *   - `searchTeams(query)` became `listTeams()`. The plan wants the team list
 *     fetched once, cached for 24 h, and filtered locally, and that caching can
 *     only happen above the provider.
 *   - `getSlate` / `slateKeyFor` are new. Live scores come from one slate
 *     request shared by every team playing that day, not one request per team.
 *     That matters under ESPN's burst throttling (docs/espn-notes.md §1).
 *   - Games come back as `ProviderGame`, with no point of view. Turning a game
 *     into "our score / their score" is provider-agnostic, so it lives in
 *     `services/perspective.ts`.
 */
export interface SportsDataProvider {
  readonly name: ProviderName;

  /** The provider's own calendar (§21). `null` when it has no opinion. */
  getCurrentSeason(): Promise<Season | null>;

  /** Every team the provider knows. The admin search source (§43). */
  listTeams(): Promise<TeamIdentity[]>;

  /** A team's full season schedule, from no team's point of view. */
  getTeamSchedule(providerTeamId: string, season: Season): Promise<ProviderSchedule>;

  /** The poll to display for this season (CFP when published, else AP). `null` if none. */
  getRankings(season: Season): Promise<RankingsSnapshot | null>;

  /**
   * The slate a kickoff belongs to: the unit in which live scores are fetched.
   * Pure, synchronous, and provider-specific (ESPN groups by US Eastern date).
   */
  slateKeyFor(kickoffUtc: string): string;

  /** Every game in one slate, with current status, score, and clock. */
  getSlate(slateKey: string): Promise<ProviderGame[]>;

  getGame(providerGameId: string): Promise<ProviderGame>;

  /** The provider's own prediction, or `null` when it publishes none (§12, §46). */
  getPrediction(providerGameId: string): Promise<Prediction | null>;
}

// ─── Provider-layer data shapes ──────────────────────────────────────────────
// Normalized, but not yet from any team's perspective. Internal to the API:
// the web app never sees these, only the `Game` they are converted into.

export interface ProviderCompetitor {
  team: TeamRef;
  /** `null` unless the game is live or final. A postponed "0" is not a score. */
  score: number | null;
  /**
   * The provider's own verdict. `null` unless `status === 'final'`, which is
   * what makes `result !== null ⟺ status === 'final'` hold downstream.
   */
  winner: boolean | null;
  /** The team's season record as of this game, as the provider reported it. */
  record: TeamRecord | null;
}

export interface ProviderGame {
  providerGameId: string;
  season: Season;
  week: number | null;
  kickoffUtc: string;
  kickoffTbd: boolean;
  status: GameStatus;
  statusDetail: string | null;
  period: number | null;
  clock: string | null;
  neutralSite: boolean;
  venue: string | null;
  broadcast: string | null;
  home: ProviderCompetitor;
  away: ProviderCompetitor;
}

export interface ProviderSchedule {
  season: Season;
  games: ProviderGame[];
  /**
   * Events the provider sent that failed validation and were dropped (§40).
   * Non-zero means the schedule has holes, so a gap in the week numbers can no
   * longer be read as a bye. `services/snapshot.ts` stops inferring byes.
   */
  droppedEvents: number;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type ProviderErrorKind = 'unavailable' | 'invalid_response' | 'not_found';

/**
 * The only thing a provider throws.
 *
 * `retryable` is about the provider's state, not ours: a timeout, a 5xx, or
 * ESPN's Akamai throttle (a bare 403) might succeed on the next attempt. A
 * payload that failed validation will not.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  /** Upstream HTTP status, when there was one. For logs only. */
  readonly status: number | null;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { retryable?: boolean; status?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
  }
}

/** §38 — one application error kind per provider failure mode. */
export function appErrorKindFor(error: ProviderError): AppErrorKind {
  switch (error.kind) {
    case 'unavailable':
      return 'provider_unavailable';
    case 'invalid_response':
      return 'provider_invalid_response';
    case 'not_found':
      return 'not_found';
  }
}
