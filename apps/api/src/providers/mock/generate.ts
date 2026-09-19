import type { GameStatus, Season, SeasonType, TeamRecord } from '@cfb/shared';
import type { ProviderCompetitor, ProviderGame } from '../types';
import { ROSTER, type RosterTeam } from './roster';

/**
 * A synthetic season, generated deterministically from (season, now).
 *
 * Built so that every board in mock mode shows the states the UI has to
 * handle, at any hour of any day: final games, upcoming games, TBD kickoffs, a
 * few games LIVE right now, bye weeks, a postponement, a cancellation, neutral
 * sites, ranked and unranked teams, predictions present and absent. It is
 * relative to the real clock, so the board always looks mid-season, and it
 * is pure, so tests pin the clock and get the same season every time.
 *
 * Pairings use the circle method, so the schedules agree with each other: if
 * Alabama plays Georgia in week 4, Georgia's schedule says so too, under the
 * same game id.
 */

export const SEASON_WEEKS = 12;
export const DEFAULT_CURRENT_WEEK = 6;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const GAME_LENGTH = 3.5 * HOUR;

/** Noon, 3:30 PM, and 7:30 PM US Eastern (daylight time), as UTC offsets from Saturday 00:00Z. */
const KICKOFF_SLOTS = [16 * HOUR, 19.5 * HOUR, 23.5 * HOUR];
/** Unannounced kickoffs sit at midnight Eastern, the same placeholder ESPN uses. */
const TBD_KICKOFF = 4 * HOUR;
/** Games more than this many weeks out have no announced time yet. */
const TBD_AFTER_WEEKS = 2;
/**
 * A live pair's kickoff is re-anchored every three hours, 30 minutes before
 * the window opens, so it is always 30–210 minutes old and so always in progress.
 */
const LIVE_CYCLE = 3 * HOUR;
const LIVE_LEAD = 30 * MINUTE;

const BROADCASTS = ['ESPN', 'ABC', 'FOX', 'CBS', 'SECN', 'BTN', 'ACCN', 'ESPN2'];

/** FNV-1a. Tiny, deterministic, and good enough to scatter mock states. */
export function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

// ─── The timeline ────────────────────────────────────────────────────────────

const SEASON_TYPE_DIGIT: Record<SeasonType, string> = {
  preseason: '1',
  regular: '2',
  postseason: '3',
};
const DIGIT_SEASON_TYPE: Record<string, SeasonType> = {
  '1': 'preseason',
  '2': 'regular',
  '3': 'postseason',
};

/**
 * Which mock week "now" falls in. Postseason puts every game in the past (the
 * season-complete state, reached with SEASON_OVERRIDE=<year>:postseason) and
 * preseason puts every game in the future.
 */
export function currentWeekFor(season: Season): number {
  if (season.type === 'postseason') return SEASON_WEEKS + 3;
  if (season.type === 'preseason') return 0;
  const week = season.week ?? DEFAULT_CURRENT_WEEK;
  return Math.min(Math.max(week, 1), SEASON_WEEKS);
}

/** Saturday 00:00Z of this football week. Sunday and Monday still belong to the Saturday before. */
function anchorSaturday(now: number): number {
  const date = new Date(now);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const weekday = date.getUTCDay();
  const offsetDays = weekday <= 1 ? -(weekday + 1) : 6 - weekday;
  return midnight + offsetDays * DAY;
}

// ─── Pairings ────────────────────────────────────────────────────────────────

/** Round `round` of a single round-robin over `size` teams (size must be even). */
function pairings(size: number, round: number): [number, number][] {
  const rest = Array.from({ length: size - 1 }, (_, index) => index + 1);
  const shift = round % rest.length;
  const rotated = [...rest.slice(shift), ...rest.slice(0, shift)];
  const circle = [0, ...rotated];
  const pairs: [number, number][] = [];
  for (let index = 0; index < size / 2; index += 1) {
    pairs.push([circle[index] ?? 0, circle[size - 1 - index] ?? 0]);
  }
  return pairs;
}

// ─── Game ids ────────────────────────────────────────────────────────────────

interface GameKey {
  year: number;
  type: SeasonType;
  currentWeek: number;
  week: number;
  home: number;
  away: number;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * Digits only, like an ESPN id, and self-describing, so `getGame(id)` can
 * rebuild the exact game without any state: year, season type, the current
 * week the timeline was built around, the game's week, and both roster slots.
 */
export function encodeGameId(key: GameKey): string {
  return `${String(key.year)}${SEASON_TYPE_DIGIT[key.type]}${pad2(key.currentWeek)}${pad2(key.week)}${pad2(key.home)}${pad2(key.away)}`;
}

export function decodeGameId(id: string): GameKey | null {
  const match = /^(\d{4})([123])(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(id);
  if (match === null) return null;
  const [, year, type, currentWeek, week, home, away] = match;
  const seasonType = DIGIT_SEASON_TYPE[type ?? ''];
  if (seasonType === undefined) return null;
  return {
    year: Number(year),
    type: seasonType,
    currentWeek: Number(currentWeek),
    week: Number(week),
    home: Number(home),
    away: Number(away),
  };
}

// ─── Generation ──────────────────────────────────────────────────────────────

interface Slot {
  key: GameKey;
  pairIndex: number;
}

/**
 * Every team has one bye week of its own, somewhere in weeks 2–10. A pair
 * rests when either team's bye falls that week, so most teams see one or two
 * byes, like a real season.
 */
function byeWeekOf(teamIndex: number, year: number): number {
  return 2 + (hash(`bye:${String(teamIndex)}:${String(year)}`) % 9);
}

/** The season's games, without records (those need the whole season, below). */
function scheduleSlots(season: Season): Slot[] {
  const currentWeek = currentWeekFor(season);
  const slots: Slot[] = [];
  for (let week = 1; week <= SEASON_WEEKS; week += 1) {
    pairings(ROSTER.length, week - 1).forEach(([first, second], pairIndex) => {
      if (byeWeekOf(first, season.year) === week || byeWeekOf(second, season.year) === week) return;
      const [home, away] = (week + pairIndex) % 2 === 0 ? [first, second] : [second, first];
      slots.push({
        key: { year: season.year, type: season.type, currentWeek, week, home, away },
        pairIndex,
      });
    });
  }
  return slots;
}

interface Timing {
  kickoff: number;
  tbd: boolean;
  forced: GameStatus | null;
}

function timingOf(slot: Slot, now: number): Timing {
  const { key, pairIndex } = slot;
  const weekStart = anchorSaturday(now) + (key.week - key.currentWeek) * WEEK;

  if (key.week === key.currentWeek && pairIndex % 5 === 0) {
    return {
      kickoff: Math.floor(now / LIVE_CYCLE) * LIVE_CYCLE - LIVE_LEAD,
      tbd: false,
      forced: null,
    };
  }
  if (key.week === key.currentWeek - 1 && pairIndex % 5 === 2) {
    return { kickoff: weekStart + (KICKOFF_SLOTS[1] ?? 0), tbd: false, forced: 'postponed' };
  }
  if (key.week === key.currentWeek - 3 && pairIndex % 6 === 3) {
    return { kickoff: weekStart + (KICKOFF_SLOTS[0] ?? 0), tbd: false, forced: 'canceled' };
  }
  if (key.week >= key.currentWeek + TBD_AFTER_WEEKS) {
    return { kickoff: weekStart + TBD_KICKOFF, tbd: true, forced: null };
  }
  return {
    kickoff: weekStart + (KICKOFF_SLOTS[pairIndex % KICKOFF_SLOTS.length] ?? 0),
    tbd: false,
    forced: null,
  };
}

function finalScores(id: string): [number, number] {
  const value = hash(`score:${id}`);
  const home = 10 + (value % 35);
  let away = 10 + ((value >>> 8) % 35);
  if (away === home) away += 3;
  return [home, away];
}

const ORDINALS = ['1st', '2nd', '3rd', '4th'];

interface Played {
  status: GameStatus;
  detail: string | null;
  period: number | null;
  clock: string | null;
  home: number | null;
  away: number | null;
}

function playState(id: string, timing: Timing, now: number): Played {
  const none = { period: null, clock: null, home: null, away: null };
  if (timing.forced === 'postponed') return { status: 'postponed', detail: 'Postponed', ...none };
  if (timing.forced === 'canceled') return { status: 'canceled', detail: 'Canceled', ...none };
  if (now < timing.kickoff) return { status: 'scheduled', detail: null, ...none };

  const [home, away] = finalScores(id);
  const elapsed = now - timing.kickoff;
  if (elapsed >= GAME_LENGTH) {
    return { status: 'final', detail: 'Final', period: null, clock: null, home, away };
  }

  const fraction = elapsed / GAME_LENGTH;
  const gameMinutes = fraction * 60;
  const period = Math.min(4, Math.floor(gameMinutes / 15) + 1);
  const remaining = Math.max(0, period * 15 - gameMinutes);
  const minutes = Math.floor(remaining);
  const seconds = Math.floor((remaining - minutes) * 60);
  const clock = `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
  return {
    status: 'live',
    detail: `${clock} - ${ORDINALS[period - 1] ?? `${String(period)}th`} Quarter`,
    period,
    clock,
    home: Math.floor(home * fraction),
    away: Math.floor(away * fraction),
  };
}

function refOf(team: RosterTeam): ProviderCompetitor['team'] {
  return { providerTeamId: team.id, name: team.short, abbreviation: team.abbr, logoUrl: null };
}

interface Tally {
  wins: number;
  losses: number;
  confWins: number;
  confLosses: number;
}

function recordOf(tally: Tally): TeamRecord {
  return {
    wins: tally.wins,
    losses: tally.losses,
    ties: null,
    summary: `${String(tally.wins)}-${String(tally.losses)}`,
    conference: { wins: tally.confWins, losses: tally.confLosses },
  };
}

/** Every game of the mock season, in kickoff order, each competitor carrying its record to date. */
export function generateSeason(season: Season, now: number): ProviderGame[] {
  const built = scheduleSlots(season).map((slot) => {
    const id = encodeGameId(slot.key);
    const timing = timingOf(slot, now);
    return { slot, id, timing, played: playState(id, timing, now) };
  });
  built.sort((a, b) => a.timing.kickoff - b.timing.kickoff);

  const tallies = new Map<string, Tally>();
  const tallyOf = (id: string): Tally => {
    let tally = tallies.get(id);
    if (tally === undefined) {
      tally = { wins: 0, losses: 0, confWins: 0, confLosses: 0 };
      tallies.set(id, tally);
    }
    return tally;
  };

  return built.map(({ slot, id, timing, played }) => {
    const home = ROSTER[slot.key.home];
    const away = ROSTER[slot.key.away];
    if (home === undefined || away === undefined) throw new Error('mock roster index out of range');

    const final = played.status === 'final';
    const homeWon = final && (played.home ?? 0) > (played.away ?? 0);
    if (final) {
      const conference = home.conference === away.conference;
      const [winner, loser] = homeWon ? [home, away] : [away, home];
      const won = tallyOf(winner.id);
      const lost = tallyOf(loser.id);
      won.wins += 1;
      lost.losses += 1;
      if (conference) {
        won.confWins += 1;
        lost.confLosses += 1;
      }
    }

    const neutralSite = (slot.pairIndex * 7 + slot.key.week) % 17 === 0;
    return {
      providerGameId: id,
      // Every mock game is a regular-season game, whichever phase the timeline
      // is built around, as ESPN's are: in the postseason a team's week-4 game
      // is still a regular-season game, and its bye weeks are still gaps in
      // regular-season weeks. The phase lives in the game id, for `getGame`.
      season: { year: season.year, type: 'regular', week: slot.key.week },
      week: slot.key.week,
      kickoffUtc: new Date(timing.kickoff).toISOString(),
      kickoffTbd: timing.tbd,
      status: played.status,
      statusDetail: played.detail,
      period: played.period,
      clock: played.clock,
      neutralSite,
      venue: neutralSite ? 'Neutral Site Stadium' : `${home.short} Stadium`,
      broadcast: timing.tbd ? null : (BROADCASTS[hash(`tv:${id}`) % BROADCASTS.length] ?? null),
      home: {
        team: refOf(home),
        score: played.home,
        winner: final ? homeWon : null,
        record: tallies.has(home.id) ? recordOf(tallyOf(home.id)) : null,
      },
      away: {
        team: refOf(away),
        score: played.away,
        winner: final ? !homeWon : null,
        record: tallies.has(away.id) ? recordOf(tallyOf(away.id)) : null,
      },
    };
  });
}

/** The season a mock game id was generated in, so `getGame` rebuilds the same timeline. */
export function seasonOfGameId(id: string): Season | null {
  const key = decodeGameId(id);
  if (key === null) return null;
  return { year: key.year, type: key.type, week: key.type === 'regular' ? key.currentWeek : null };
}
