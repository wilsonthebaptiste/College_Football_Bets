/**
 * ESPN's shapes, as `validate.ts` hands them to `normalize.ts` (§41).
 *
 * These are ESPN's structures with every field already narrowed: a string is a
 * string, a missing or mistyped value is `null`, and an array is always an
 * array. Nothing here is trusted beyond "has this type". Whether the values
 * make sense is `normalize.ts`'s question.
 *
 * Field comments give the ESPN path each one was read from. docs/espn-notes.md
 * is the reference for why each path was chosen.
 */

export interface RawLogo {
  href: string;
  rel: string[];
}

export interface RawTeam {
  /** `team.id`. Numeric ids are accepted and stringified. */
  id: string;
  displayName: string | null;
  shortDisplayName: string | null;
  /** The mascot half: "Longhorns". */
  name: string | null;
  /** The place half: "Texas". Summary payloads have this but no shortDisplayName. */
  location: string | null;
  abbreviation: string | null;
  color: string | null;
  alternateColor: string | null;
  /** `team.logos[]`. Empty when absent. */
  logos: RawLogo[];
  /** `team.logo`: schedule and scoreboard use a bare string instead of `logos[]`. */
  logo: string | null;
}

/**
 * Three score shapes, one per payload family (espn-notes §3):
 *   schedule    `score: { value: 59, displayValue: "59" }`
 *   scoreboard  `score: "27"`
 *   summary     `score: "27"`
 * and the key is absent entirely for upcoming games (`null` here).
 */
export type RawScore =
  | { shape: 'object'; value: number | null; displayValue: string | null }
  | { shape: 'string'; text: string };

/**
 * One entry of a competitor's season record. Three shapes again:
 *   schedule    `record[]`  with `displayValue`
 *   summary     `record[]`  with `summary` (and `displayValue`)
 *   scoreboard  `records[]` with `summary`
 * `validate.ts` reads whichever is present into `summary`.
 */
export interface RawRecordEntry {
  /** `total`, `vsconf`, `home`, `road`/`away`… */
  type: string;
  summary: string | null;
}

export interface RawCompetitor {
  /** §19 — the provider's own designation, never inferred from order. */
  homeAway: 'home' | 'away';
  team: RawTeam;
  score: RawScore | null;
  /** Present only on completed games. */
  winner: boolean | null;
  /** Scoreboard/schedule only. `99` means unranked (espn-notes §2). */
  curatedRank: number | null;
  records: RawRecordEntry[];
}

/** `competition.status` */
export interface RawStatus {
  /** `type.name`, e.g. `STATUS_FINAL`. The key the status map uses. */
  name: string | null;
  /** `type.state`: pre / in / post. NEVER used alone to decide finality. */
  state: string | null;
  /** `type.completed`: the ONLY signal of finality (espn-notes §3). */
  completed: boolean | null;
  detail: string | null;
  shortDetail: string | null;
  period: number | null;
  displayClock: string | null;
}

/** A game in any of the three payload families, flattened to one shape. */
export interface RawEvent {
  id: string;
  /** Minute precision, no seconds: `<yyyy>-09-05T19:30Z`. Already checked to parse. */
  date: string;
  /** `false` when the kickoff time is TBD and `date` holds a midnight placeholder. */
  timeValid: boolean | null;
  seasonYear: number | null;
  /** 1 preseason, 2 regular, 3 postseason, 4 off season. */
  seasonType: number | null;
  week: number | null;
  neutralSite: boolean | null;
  venue: string | null;
  broadcast: string | null;
  status: RawStatus | null;
  home: RawCompetitor;
  away: RawCompetitor;
}

/** `teams/{id}/schedule` */
export interface RawSchedule {
  /** `requestedSeason`. The root `season` is ESPN's *current* season, whatever was asked. */
  requestedSeasonYear: number | null;
  requestedSeasonType: number | null;
  events: RawEvent[];
  droppedEvents: number;
}

/** `scoreboard?dates=…` */
export interface RawScoreboard {
  events: RawEvent[];
  droppedEvents: number;
}

/** Bare `scoreboard`: the season/week calendar (espn-notes §8). */
export interface RawCalendar {
  seasonYear: number;
  seasonType: number;
  week: number | null;
}

/** `summary?event={id}` */
export interface RawSummary {
  event: RawEvent;
  /** Top-level `predictor`, present for upcoming games (espn-notes §6A). */
  predictor: RawInlinePredictor | null;
}

/** `summary.predictor`: projections arrive as strings, e.g. `"91.7"`. */
export interface RawInlinePredictor {
  homeTeamId: string | null;
  homeProjection: number | null;
  awayTeamId: string | null;
  awayProjection: number | null;
}

/** Core API `…/competitions/{id}/predictor` (espn-notes §6B). */
export interface RawStandalonePredictor {
  homeProjection: number | null;
  awayProjection: number | null;
}

export interface RawRank {
  /** `ranks[].current`. `others[]` carry `current: 0` and are never read. */
  current: number;
  team: RawTeam;
  recordSummary: string | null;
}

export interface RawPoll {
  /** `ap`, `usa`, `fcs`, `afca`… and, from about week 10, the CFP poll. */
  type: string | null;
  name: string | null;
  shortName: string | null;
  /** `occurrence.number` */
  week: number | null;
  seasonYear: number | null;
  /** `null` when ANY entry failed validation: a dropped entry would turn a ranked team into NR. */
  ranks: RawRank[] | null;
}

/** `rankings` */
export interface RawRankings {
  polls: RawPoll[];
}
