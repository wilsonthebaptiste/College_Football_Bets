/**
 * Centralized season resolution (§21).
 *
 * This is the ONLY module in application source allowed to reason about what
 * year it is. `npm run check:season` scans every workspace `src` tree for
 * four-digit year literals and fails if one appears outside this file, a test,
 * or a fixture. The point is that rolling into a new season is a data change,
 * never a code change.
 *
 * Precedence, highest first:
 *   1. `SEASON_OVERRIDE` env var  — an operator pinning the season by hand
 *   2. the provider's own calendar — authoritative, knows the week number
 *   3. the date heuristic below   — always works, never knows the week
 */

export type SeasonType = 'preseason' | 'regular' | 'postseason';

export interface Season {
  year: number;
  type: SeasonType;
  /** Week number when a source knows it. The date heuristic never does. */
  week: number | null;
}

export const SEASON_TYPES: readonly SeasonType[] = ['preseason', 'regular', 'postseason'];

// ─── Date heuristic boundaries ───────────────────────────────────────────────
// Months are 0-indexed, matching `Date.prototype.getUTCMonth`.

/**
 * From July onward the calendar year IS the season year; before July we are
 * still inside the previous season (a January bowl game belongs to the season
 * that started the preceding August).
 */
const SEASON_YEAR_ROLLOVER_MONTH = 6; // July

/** College football kicks off in the last full week of August. */
const REGULAR_SEASON_START_MONTH = 7; // August
const REGULAR_SEASON_START_DAY = 21;

/** Conference championships, bowls, and the playoff run December into January. */
const POSTSEASON_START_MONTH = 11; // December

/**
 * The fallback. Correct about the season *year* in every month; deliberately
 * approximate about the season *type* near the August boundary, and never
 * claims to know the week.
 */
export function resolveSeasonFromDate(now: Date): Season {
  const calendarYear = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  const year = month >= SEASON_YEAR_ROLLOVER_MONTH ? calendarYear : calendarYear - 1;

  let type: SeasonType;
  if (
    month === SEASON_YEAR_ROLLOVER_MONTH ||
    (month === REGULAR_SEASON_START_MONTH && day < REGULAR_SEASON_START_DAY)
  ) {
    type = 'preseason';
  } else if (month >= REGULAR_SEASON_START_MONTH && month < POSTSEASON_START_MONTH) {
    type = 'regular';
  } else {
    // December through June: bowls, playoff, then the long quiet (§22).
    type = 'postseason';
  }

  return { year, type, week: null };
}

// ─── SEASON_OVERRIDE parsing ─────────────────────────────────────────────────

function isSeasonType(value: string): value is SeasonType {
  return (SEASON_TYPES as readonly string[]).includes(value);
}

function isPlausibleSeasonYear(year: number): boolean {
  // Four digits, integer. Expressed this way rather than as a numeric range so
  // that this file contains no year literal of its own.
  return Number.isInteger(year) && String(year).length === 4;
}

/**
 * Parses the `SEASON_OVERRIDE` env var.
 *
 * Accepted: `"<year>"`, `"<year>:<type>"`, `"<year>:<type>:<week>"`
 * Anything else returns `null` and the chain falls through to the next source —
 * a typo in an env var must not take the application down.
 */
export function parseSeasonOverride(raw: string | null | undefined): Season | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const parts = trimmed.split(':');
  if (parts.length > 3) return null;

  const [rawYear, rawType, rawWeek] = parts;
  if (rawYear === undefined) return null;

  const year = Number(rawYear);
  if (!isPlausibleSeasonYear(year)) return null;

  let type: SeasonType = 'regular';
  if (rawType !== undefined) {
    const normalized = rawType.trim().toLowerCase();
    if (!isSeasonType(normalized)) return null;
    type = normalized;
  }

  let week: number | null = null;
  if (rawWeek !== undefined) {
    const parsed = Number(rawWeek);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    week = parsed;
  }

  return { year, type, week };
}

// ─── The precedence chain ────────────────────────────────────────────────────

export type SeasonSource = 'override' | 'provider' | 'date';

export interface ResolvedSeason {
  season: Season;
  source: SeasonSource;
}

export interface SeasonResolutionDeps {
  now: Date;
  /** Raw `SEASON_OVERRIDE` value, unparsed. */
  override?: string | null | undefined;
  /**
   * Reads the provider's calendar. Should resolve to `null` (not throw) when the
   * provider has no opinion; if it throws, the chain still falls through to the
   * date heuristic, because an unreachable provider must not break the season.
   */
  fetchProviderSeason?: (() => Promise<Season | null>) | null | undefined;
}

export async function resolveCurrentSeason(deps: SeasonResolutionDeps): Promise<ResolvedSeason> {
  const overridden = parseSeasonOverride(deps.override);
  if (overridden !== null) {
    return { season: overridden, source: 'override' };
  }

  if (typeof deps.fetchProviderSeason === 'function') {
    try {
      const fromProvider = await deps.fetchProviderSeason();
      if (fromProvider !== null && isPlausibleSeasonYear(fromProvider.year)) {
        return { season: fromProvider, source: 'provider' };
      }
    } catch {
      // Deliberately swallowed: the date heuristic below is a correct answer,
      // and a provider outage must never leave the app without a season.
    }
  }

  return { season: resolveSeasonFromDate(deps.now), source: 'date' };
}

// ─── How much season is behind us ────────────────────────────────────────────
// Used by the projected-points rubric (`scoring.ts`) to weight a team's current
// poll position against a rank-based model of where it finishes. It lives here,
// and takes a `Season` rather than a `Date`, for the same two reasons the rest
// of this module does: `check:season` forbids a year literal elsewhere, and the
// season is already resolved once per request, so nothing downstream should be
// reading the clock a second time.

/** Regular-season weeks the weighting is spread over. */
export const REGULAR_WEEKS = 15;

/**
 * The most weight the regular season ever gives the current fact. Short of 1
 * because a team ranked in November can still fall out of the final poll.
 */
const REGULAR_SEASON_MAX_WEIGHT = 0.8;

/**
 * The date heuristic never knows the week (see `resolveSeasonFromDate`). Half of
 * the regular season's maximum is the honest answer to "somewhere in there".
 */
const UNKNOWN_WEEK_WEIGHT = 0.4;

/**
 * Not 1.0 on purpose: the final poll comes AFTER the bowls, so a team ranked in
 * December can still drop out of it. The residual is honest uncertainty.
 */
const POSTSEASON_WEIGHT = 0.95;

/**
 * 0 before a snap has been played, rising through the regular season, highest in
 * the postseason. Monotone across preseason → week 15 → postseason.
 */
export function seasonProgress(season: Season): number {
  switch (season.type) {
    case 'preseason':
      return 0;
    case 'regular': {
      if (season.week === null || !Number.isFinite(season.week)) return UNKNOWN_WEEK_WEIGHT;
      const week = Math.min(Math.max(season.week, 0), REGULAR_WEEKS);
      return (REGULAR_SEASON_MAX_WEIGHT * week) / REGULAR_WEEKS;
    }
    case 'postseason':
      return POSTSEASON_WEIGHT;
  }
}

// ─── Small helpers ───────────────────────────────────────────────────────────

/**
 * Stable cache-key fragment. Deliberately excludes `week` — a schedule cached
 * on Tuesday of week 5 is still the same season's schedule on Wednesday, and
 * including the week would evict the entire cache every seven days.
 */
export function seasonKey(season: Season): string {
  return `${String(season.year)}:${season.type}`;
}

export function isSameSeason(a: Season, b: Season): boolean {
  return a.year === b.year && a.type === b.type;
}

export function formatSeasonLabel(season: Season): string {
  const suffix = season.week === null ? '' : ` · Week ${String(season.week)}`;
  return `${String(season.year)} ${season.type}${suffix}`;
}
