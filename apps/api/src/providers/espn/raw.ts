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

/**
 * `leagues[0].calendar` on a scoreboard (bare, or `?week=`): one phase per
 * ESPN season type, each a list of weeks with its own date window.
 *
 *   { label: "Regular Season", value: "2", entries: [
 *       { label: "Week 6", value: "6", startDate: "<yyyy>-10-05T07:00Z", endDate: … } ] }
 *
 * The postseason's weeks are not a weekly rhythm: "Bowls" is value `1` and
 * "CFP" is value `999`, and their windows overlap.
 */
export interface RawCalendarWeeks {
  /** `leagues[0].season.year`, else the root `season.year`. */
  seasonYear: number | null;
  phases: RawCalendarPhase[];
}

export interface RawCalendarPhase {
  /** `value`, as a number: 1 preseason, 2 regular, 3 postseason, 4 off season. */
  seasonType: number;
  weeks: RawCalendarWeek[];
}

export interface RawCalendarWeek {
  /** `value`, as a number. */
  week: number;
  label: string | null;
  /** Already checked to parse. */
  startDate: string;
  endDate: string;
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

// ─── Conferences (espn-notes §7) ─────────────────────────────────────────────

/**
 * A core-API collection page: `{ count, pageCount, items: [{ $ref }] }`. Each
 * `$ref` is a URL whose last path id is what we want (a group or a team).
 */
export interface RawRefPage {
  /** The ids read out of `items[].$ref`, in order. Unreadable refs are skipped. */
  ids: string[];
  /** `count`: how many the collection holds, to notice a truncated page. */
  count: number | null;
}

/** `…/seasons/{year}/types/2/groups/{id}`: one conference. */
export interface RawGroup {
  id: string;
  /** `shortName`: "SEC", "Big Ten", "Sun Belt". What a card shows. */
  shortName: string | null;
  /** `name`: "Southeastern Conference". */
  name: string | null;
}

// ─── Football Power Index (docs/espn-notes.md §12) ───────────────────────────

/**
 * One team's row of the `fpi` category, with every field already pulled out of
 * the parallel `values` array BY NAME.
 *
 * The payload's shape is a table, not a record: each team carries
 * `categories[name="fpi"].values`, a bare array of numbers aligned with the
 * `names` array on the document's own `categories` entry. The sibling `labels`
 * array has nulls in it and the order is ESPN's to change, so reading by index
 * would eventually put "projected losses" where a probability belongs — a
 * number that is still a plausible number, which is the dangerous kind of bug.
 *
 * Percentages here are still percentages (`27.800000000000004`). Dividing by
 * 100 is `normalize.ts`'s job.
 */
export interface RawFpiTeam {
  /** `teams[].team.id`, the same id space as every other ESPN payload. */
  teamId: string;
  /** `probwintitle` */
  winTitlePercent: number | null;
  /** `probmaketitlegame` */
  makeTitleGamePercent: number | null;
  /** `probmakeplayoffs` */
  makePlayoffsPercent: number | null;
  /** `probwinconf` — the labelled fallback for the conference champion term. */
  winConferencePercent: number | null;
  /** `fpirank`, 1-based. Carries the Top-25 estimate for a team the poll omits. */
  fpiRank: number | null;
}

/** `powerindex?limit=…` */
export interface RawFpiPage {
  teams: RawFpiTeam[];
  /** `lastUpdated`: a daily morning recompute, as `<yyyy>-MM-DDTHH:mmZ`. */
  lastUpdated: string | null;
  /** `pagination.count` — how many teams ESPN says it has. */
  count: number | null;
  /** `pagination.pages` — anything above 1 means the read was truncated. */
  pages: number | null;
  /** Entries that carried no usable id or no `fpi` category, and were skipped. */
  droppedTeams: number;
}
