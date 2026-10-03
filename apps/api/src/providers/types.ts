import type {
  AppErrorKind,
  FpiProjectionInputs,
  GameStatus,
  Prediction,
  ProviderName,
  RankingsSnapshot,
  Season,
  SeasonWeek,
  SportsProviderName,
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
  readonly name: SportsProviderName;

  /**
   * Whose id space `providerTeamId` belongs to, which is what the `teams`
   * table's `provider` column records (§43). Usually the provider's own name.
   * The mock borrows ESPN's ids, so that every seeded board resolves in mock
   * mode, and says so here: a team the administrator adds in mock mode is the
   * same `teams` row as in ESPN mode, not a mock-only duplicate.
   */
  readonly teamNamespace: SportsProviderName;

  /** The provider's own calendar (§21). `null` when it has no opinion. */
  getCurrentSeason(): Promise<Season | null>;

  /** Every team the provider knows. The admin search source (§43). */
  listTeams(): Promise<TeamIdentity[]>;

  /**
   * Conference short names for a season, keyed by provider team id: `SEC`,
   * `Big Ten`. Teams in no conference the provider lists are simply absent.
   * Shown beside each team in the admin search (§43, plan §5.1) and stored
   * with a team when it is added to a board.
   */
  getConferences(season: Season): Promise<ConferenceMap>;

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

  /**
   * The weeks of one season phase, in the provider's own numbering and words
   * (the matchup board's navigation). Empty when the provider's calendar has
   * no weeks for that phase — the preseason, or a calendar for some other
   * season — which is data, not an error.
   */
  getSeasonWeeks(season: Season): Promise<SeasonWeek[]>;

  /**
   * Every game in one week of a season, from no team's point of view: one
   * request for the lot (context/plan-matchup-board.md, Phase 1). The same
   * normalized shape `getSlate` returns, so the live overlay applies to it.
   */
  getWeekGames(season: Season, week: number): Promise<ProviderGame[]>;

  /** The provider's own prediction, or `null` when it publishes none (§12, §46). */
  getPrediction(providerGameId: string): Promise<Prediction | null>;

  /**
   * Every team the provider publishes playoff and championship probabilities
   * for: the national half of the projected-points rubric
   * (context/predicting_score.md).
   *
   * One request for the lot, like `listTeams`, because it is one document.
   * A team the publisher does not cover is simply absent — ESPN's FPI covers
   * 138 of its own ~762 teams, so most of them have no projection at all. That
   * is an `unavailable`, never a zero.
   */
  getTeamProjections(): Promise<TeamProjectionsDocument>;
}

// ─── Conference odds: a second publisher, deliberately separate ──────────────

/**
 * Conference championship odds for one season, as one publisher computes them.
 *
 * This is its own interface and its own registry entry rather than a method on
 * `SportsDataProvider`, for the mirror of project rule 2: only
 * `providers/espn/` may know ESPN exists, so only `providers/playoffstatus/`
 * may know that site exists. Keeping them apart is also what lets the two fail,
 * be faulted, and be mocked independently — the conference half of the rubric
 * can be down while the national half is fine, and the screen says which.
 */
export interface ConferenceOddsProvider {
  readonly name: ProviderName;
  getConferenceOdds(season: Season): Promise<ConferenceOddsDocument>;
}

/**
 * One team's conference odds, keyed by the publisher's OWN spelling.
 *
 * Resolving "Mississippi St." to a provider team id needs the team list, which
 * belongs to the other provider, so the join lives in `services/projection.ts`
 * and not in here. A publisher that had to know ESPN's ids would be a publisher
 * this application had taught about ESPN.
 */
export interface ConferenceOddsRow {
  /** Verbatim, as published: "Mississippi St.", "Texas A&M", "Pittsburgh". */
  teamName: string;
  /** The conference page this row came from, by its short name: `SEC`, `Big Ten`. */
  conference: string;
  /** P(wins its conference), 0–1. */
  winConference: number;
  /** P(plays in the conference championship game), 0–1. */
  reachConferenceGame: number;
}

/**
 * One conference's page: when the publisher says it computed it, and the two
 * column sums that are the scrape's own integrity check.
 *
 * There is one champion and there are two finalists per conference, so the
 * sums should be about 100 and about 200. A parse that drops a row — which a
 * single regex over the whole table did, silently, one row per page — breaks
 * both at once. HTML cannot be validated the way JSON can, so this, the row
 * count, and the two-way join are the only warning a redesign will ever give.
 */
export interface ConferenceOddsPage {
  conference: string;
  /**
   * This page's own stamp, verbatim: "Sat Sep 26 11:30 pm". NEVER parsed.
   *
   * Our `fetchedAt` would say "seconds ago" for a figure computed four days
   * ago, which is §39's failure in a new costume. The string has no year and no
   * timezone, so parsing it into an instant would mean inventing a zone; it is
   * carried and displayed exactly as published instead.
   */
  computedLabel: string | null;
  rows: number;
  championPercent: number;
  participatePercent: number;
}

export interface ConferenceOddsDocument {
  rows: ConferenceOddsRow[];
  /** One entry per conference page, in `POWER_FOUR` order. */
  pages: ConferenceOddsPage[];
  /**
   * The one stamp to put on a screen — and `null` when the four pages do not
   * agree on one, which is the normal case rather than the exceptional one.
   *
   * The plan assumed a single stamp for the feature. Measured: the pages are
   * recomputed in batches, and two of the four said "Sat Sep 26 11:30 pm"
   * while the other two said "Sun Sep 27 2:45 am". There is no way to tell
   * which of two such strings is older without parsing them, and parsing them
   * means inventing a timezone — so nothing here picks one. A team's
   * conference term is dated by its OWN conference's page, which `pages`
   * always carries.
   */
  computedLabel: string | null;
}

// ─── FPI, the national half ──────────────────────────────────────────────────

/** One team's FPI figures, as probabilities in 0–1 (never percentages). */
export interface TeamProjectionInputs {
  providerTeamId: string;
  fpi: FpiProjectionInputs;
  /**
   * `probwinconf`, 0–1. Not what the rubric's conference term is quoted from —
   * the owner chose playoffstatus, and the two disagree by up to about 0.75
   * projected points per team — but it arrives in the same payload for free.
   *
   * It is the documented fallback for the CHAMPION term when the scrape fails.
   * There is no runner-up equivalent anywhere in FPI, which is exactly why that
   * term then stays `unavailable` rather than being invented.
   */
  winConference: number | null;
}

/**
 * FPI's four nesting identities, measured across every team in the payload, as
 * percentages. One champion, two finalists, twelve playoff places, ten FBS
 * conference titles.
 *
 * A dropped page, a truncated `limit`, or a column read by the wrong index
 * breaks all four at once, and each is free to compute. They are a warning and
 * not an error: a publisher's own rounding drift must not take the feature down.
 */
export interface FpiFieldSums {
  winTitle: number;
  makeTitleGame: number;
  makePlayoffs: number;
  winConference: number;
}

export interface TeamProjectionsDocument {
  teams: TeamProjectionInputs[];
  /**
   * FPI's own `lastUpdated`, verbatim, as `<yyyy>-MM-DDTHH:mmZ`. Displayed,
   * never parsed — it is ESPN's statement about when it last recomputed, and
   * that is what a screen should show rather than our own read time.
   */
  computedLabel: string | null;
  fieldSums: FpiFieldSums;
}

// ─── Provider-layer data shapes ──────────────────────────────────────────────

/** Provider team id → conference short name. A plain object so it caches as JSON. */
export type ConferenceMap = Record<string, string>;
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
