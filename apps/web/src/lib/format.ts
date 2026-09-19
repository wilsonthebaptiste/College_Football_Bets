import type { Game, GameStatus, Season, TeamIdentity } from '@cfb/shared';

/**
 * Display formatting (§20). The data model holds ISO UTC timestamps only; every
 * human-readable date or time is produced here, at render, in the viewer's own
 * time zone via `Intl.DateTimeFormat`.
 *
 * Every function takes an optional `timeZone` so tests can pin one. Leaving it
 * out means "the viewer's zone".
 */

const LOCALE = 'en-US';

/**
 * College football game days are US Eastern calendar days. A kickoff with no
 * announced time (`kickoffTbd`) carries a placeholder time at midnight Eastern,
 * so its DATE is read in Eastern. Read in Pacific, the same placeholder would
 * land the game on the previous day.
 */
export const GAME_DAY_TIME_ZONE = 'America/New_York';

export interface ClockOptions {
  /** Epoch ms. Defaults to `Date.now()`. */
  now?: number;
  /** IANA zone. Defaults to the viewer's. */
  timeZone?: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(
  name: string,
  options: Intl.DateTimeFormatOptions,
  timeZone: string | undefined,
): Intl.DateTimeFormat {
  const key = `${name}|${timeZone ?? ''}`;
  let cached = formatters.get(key);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat(
      LOCALE,
      timeZone === undefined ? options : { ...options, timeZone },
    );
    formatters.set(key, cached);
  }
  return cached;
}

const WEEKDAY_DATE: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
};
const SHORT_DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
const CALENDAR_DAY: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
};

/** `YYYY-M-D` of an instant in a zone, for same-day comparisons. */
function calendarDay(ms: number, timeZone: string | undefined): string {
  const parts = formatter('day', CALENDAR_DAY, timeZone).formatToParts(ms);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The calendar day after `day`, computed on the calendar rather than by adding 24 h (DST). */
function followingDay(day: string): string {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + 1));
  return `${String(next.getUTCFullYear())}-${String(next.getUTCMonth() + 1)}-${String(next.getUTCDate())}`;
}

function relativeDay(ms: number, now: number, timeZone: string | undefined): string | null {
  const target = calendarDay(ms, timeZone);
  const today = calendarDay(now, timeZone);
  if (target === today) return 'Today';
  if (target === followingDay(today)) return 'Tomorrow';
  return null;
}

/**
 * When a game is (or was) played.
 *
 * - `Sat, Oct 3, 4:30 PM`, or `Today, 7:00 PM` / `Tomorrow, 12:00 PM`.
 * - A TBD kickoff: `Sat, Oct 3, time TBD`. Never the placeholder "12:00 AM",
 *   which would be a fabricated kickoff time (§4).
 */
export function formatKickoff(
  game: Pick<Game, 'kickoffUtc' | 'kickoffTbd'>,
  options: ClockOptions = {},
): string {
  const ms = Date.parse(game.kickoffUtc);
  if (Number.isNaN(ms)) return 'Date to be announced';

  if (game.kickoffTbd) {
    return `${formatter('date', WEEKDAY_DATE, GAME_DAY_TIME_ZONE).format(ms)}, time TBD`;
  }

  const { timeZone } = options;
  const day =
    relativeDay(ms, options.now ?? Date.now(), timeZone) ??
    formatter('date', WEEKDAY_DATE, timeZone).format(ms);
  return `${day}, ${formatter('time', TIME, timeZone).format(ms)}`;
}

/** The date alone, for a game already played: `Sat, Sep 27`. */
export function formatGameDate(
  game: Pick<Game, 'kickoffUtc' | 'kickoffTbd'>,
  options: ClockOptions = {},
): string {
  const ms = Date.parse(game.kickoffUtc);
  if (Number.isNaN(ms)) return 'Date unavailable';
  const zone = game.kickoffTbd ? GAME_DAY_TIME_ZONE : options.timeZone;
  return formatter('date', WEEKDAY_DATE, zone).format(ms);
}

/**
 * §23 — the "Last updated" time. `3:42 PM` when it is today, `Sep 17, 3:42 PM`
 * otherwise, so day-old data can never pass for this afternoon's. `null` when
 * there is no timestamp to show.
 */
export function formatUpdatedAt(iso: string | null, options: ClockOptions = {}): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;

  const { timeZone } = options;
  const time = formatter('time', TIME, timeZone).format(ms);
  if (calendarDay(ms, timeZone) === calendarDay(options.now ?? Date.now(), timeZone)) return time;
  return `${formatter('short-date', SHORT_DATE, timeZone).format(ms)}, ${time}`;
}

/** `<year> season, week 4`, or `<year> postseason`. The year comes from the data, never from code (§21). */
export function formatSeason(season: Season): string {
  const year = String(season.year);
  switch (season.type) {
    case 'regular':
      return season.week === null
        ? `${year} season`
        : `${year} season, week ${String(season.week)}`;
    case 'preseason':
      return `${year} preseason`;
    case 'postseason':
      return `${year} postseason`;
  }
}

/** `31–24`, always from the viewed team's side. */
export function formatScore(teamScore: number, opponentScore: number): string {
  return `${String(teamScore)}–${String(opponentScore)}`;
}

/**
 * A short label for any status a card should call out. `null` for the ordinary
 * cases (a scheduled game shows its kickoff; a final shows its result).
 */
export function statusLabel(game: Pick<Game, 'status' | 'statusDetail'>): string | null {
  const labels: Record<GameStatus, string | null> = {
    scheduled: null,
    final: null,
    live: 'Live',
    postponed: 'Postponed',
    canceled: 'Canceled',
    delayed: 'Delayed',
    suspended: 'Suspended',
    // §18, §40: an unrecognized provider status renders neutrally, never as a crash.
    unknown: game.statusDetail ?? 'Status unknown',
  };
  return labels[game.status];
}

function quarterLabel(period: number): string {
  const ordinals = ['1st', '2nd', '3rd', '4th'];
  if (period >= 1 && period <= 4) return `${ordinals[period - 1] ?? ''} quarter`;
  if (period === 5) return 'Overtime';
  return `${String(period - 4)}OT`;
}

/**
 * The live game's situation. The provider's own wording wins ("Halftime",
 * "End of 3rd Quarter"), because rebuilding it from period and clock would say
 * "2nd quarter, 0:00" at halftime. Period and clock are the fallback.
 */
export function liveSituation(game: Pick<Game, 'statusDetail' | 'period' | 'clock'>): string {
  if (game.statusDetail !== null && game.statusDetail.trim() !== '') return game.statusDetail;
  if (game.period !== null && game.period > 0) {
    const label = quarterLabel(game.period);
    return game.clock === null ? label : `${label}, ${game.clock}`;
  }
  return 'In progress';
}

/** What a card calls a team: "Alabama", falling back to the provider's full name. */
export function teamLabel(team: Pick<TeamIdentity, 'displayName' | 'name'>): string {
  const short = team.displayName?.trim();
  return short !== undefined && short !== '' ? short : team.name;
}

/**
 * Up to four characters for a logo placeholder or an avatar. A short
 * abbreviation ("ALA", "TA&M") is used as is; otherwise the initials of the
 * first two words, or the first two letters of a single word.
 */
export function initials(name: string, abbreviation: string | null = null): string {
  const abbr = abbreviation?.trim();
  if (abbr !== undefined && abbr !== '' && abbr.length <= 4) return abbr.toUpperCase();

  const words = name.trim().split(/\s+/).filter(Boolean);
  const [first = '', second = ''] = words;
  if (words.length >= 2) return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
  return first.slice(0, 2).toUpperCase() || '?';
}
