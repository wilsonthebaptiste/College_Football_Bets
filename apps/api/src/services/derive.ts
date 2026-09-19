import type { Game, NextGameSlot, ScheduleItem, Season, TeamRecord } from '@cfb/shared';
import type { ProviderGame } from '../providers/types';
import { recordOn, toTeamGame } from './perspective';

/**
 * Previous game, next game, live game, bye, and record, derived from a
 * schedule. Pure: no I/O, no clock of its own. All comparisons are in UTC
 * epoch milliseconds (plan Phase 2, "watch out for").
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A scheduled game stays "next" for this long past kickoff, so a game whose
 * provider status lags the kickoff (or whose live slate is unreachable) does
 * not vanish from the card at the moment it matters most.
 */
export const KICKOFF_GRACE_MS = 6 * HOUR;
/** How long after kickoff a game is worth checking against the live slate. */
export const LIVE_WINDOW_MS = 6 * HOUR;
/** A delayed or suspended game is unfinished business for this long. */
const LIMBO_MS = 3 * DAY;
/**
 * With no calendar week to go on, a gap in the week numbers only counts as a
 * bye when the next game is more than a week away, i.e. this week is empty.
 */
const BYE_HORIZON_MS = 7 * DAY;

interface TeamGame {
  source: ProviderGame;
  game: Game;
  kickoff: number;
}

function teamGamesOf(games: readonly ProviderGame[], providerTeamId: string): TeamGame[] {
  const result: TeamGame[] = [];
  for (const source of games) {
    const game = toTeamGame(source, providerTeamId);
    if (game !== null) result.push({ source, game, kickoff: Date.parse(game.kickoffUtc) });
  }
  return result.sort((a, b) => a.kickoff - b.kickoff);
}

function isNextCandidate({ game, kickoff }: TeamGame, now: number): boolean {
  switch (game.status) {
    case 'scheduled':
    case 'unknown':
      return kickoff >= now - KICKOFF_GRACE_MS;
    case 'delayed':
    case 'suspended':
      return kickoff >= now - LIMBO_MS;
    case 'postponed':
      // A postponed game with a date still ahead has been rescheduled. One
      // whose date has passed is waiting on news and is not "next" anything.
      return kickoff >= now;
    case 'live':
    case 'final':
    case 'canceled':
      return false;
  }
}

/** Nothing left to play. A lapsed postponement counts as done: it is not coming back on its old date. */
function isDone({ game, kickoff }: TeamGame, now: number): boolean {
  return (
    game.status === 'final' ||
    game.status === 'canceled' ||
    (game.status === 'postponed' && kickoff < now)
  );
}

interface ByeOptions {
  now: number;
  season: Season;
  /** False when the provider dropped events, so gaps are not evidence of anything. */
  complete: boolean;
}

/**
 * §10, §22 — a bye is a gap in the week numbers, never a row (espn-notes §4).
 *
 * With the provider calendar's week W: the team has played before W, plays
 * after W, and has nothing in W. Without it: the latest final and the next
 * game are more than one week apart, and the next game is more than a week out.
 *
 * Regular season only. Postseason "weeks" are not a weekly rhythm, and a team
 * without a bowl game is finished, not on a bye.
 */
function byeWeek(
  games: readonly TeamGame[],
  previous: TeamGame | undefined,
  next: TeamGame,
  { now, season, complete }: ByeOptions,
): { week: number | null } | null {
  if (!complete || season.type !== 'regular') return null;
  const nextWeek = next.game.week;
  if (next.game.season.type !== 'regular' || nextWeek === null) return null;

  const weeks = new Set<number>();
  for (const { game } of games) {
    if (game.season.type === 'regular' && game.week !== null) weeks.add(game.week);
  }

  if (season.week !== null) {
    const current = season.week;
    const playedBefore = [...weeks].some((week) => week < current);
    return !weeks.has(current) && playedBefore && nextWeek > current ? { week: current } : null;
  }

  const previousWeek = previous?.game.season.type === 'regular' ? previous.game.week : null;
  if (previousWeek === null || nextWeek - previousWeek < 2) return null;
  if (next.kickoff - now <= BYE_HORIZON_MS) return null;
  // Exactly one missing week is unambiguous; a longer gap is a bye without a number.
  return { week: nextWeek - previousWeek === 2 ? previousWeek + 1 : null };
}

export interface Slots {
  previousGame: Game | null;
  nextGame: NextGameSlot;
  liveGame: Game | null;
  record: TeamRecord | null;
}

export function deriveSlots(
  games: readonly ProviderGame[],
  providerTeamId: string,
  options: ByeOptions,
): Slots {
  const { now } = options;
  const all = teamGamesOf(games, providerTeamId);

  // §11 — a game in progress. Never the previous game (§9), never "final".
  const live = all.filter(({ game }) => game.status === 'live').at(-1);

  // §9 — the latest FINAL game strictly before now.
  const previous = all
    .filter(({ game, kickoff }) => game.status === 'final' && kickoff < now)
    .at(-1);

  // §8 — the record the provider reported on that game. Only that one: an
  // earlier game's record would be a true statement about the wrong week.
  const record = previous === undefined ? null : recordOn(previous.source, providerTeamId);

  const next = all.find((candidate) => candidate !== live && isNextCandidate(candidate, now));

  let nextGame: NextGameSlot;
  if (next !== undefined) {
    const bye = byeWeek(all, previous, next, options);
    nextGame =
      bye === null
        ? { kind: 'game', game: next.game }
        : { kind: 'bye', week: bye.week, following: next.game };
  } else if (all.length > 0 && all.every((candidate) => isDone(candidate, now))) {
    nextGame = { kind: 'none', reason: 'season_complete' };
  } else {
    nextGame = { kind: 'none', reason: 'no_upcoming' };
  }

  return {
    previousGame: previous?.game ?? null,
    nextGame,
    liveGame: live?.game ?? null,
    record,
  };
}

/**
 * §17 — the full schedule, with bye weeks as rows. A bye row goes before the
 * first game of a later week, whatever order postponements left the dates in.
 */
export function scheduleItems(
  games: readonly ProviderGame[],
  providerTeamId: string,
  complete: boolean,
): ScheduleItem[] {
  const all = teamGamesOf(games, providerTeamId);
  const regularWeeks = all
    .filter(({ game }) => game.season.type === 'regular' && game.week !== null)
    .map(({ game }) => game.week as number);

  const byes: number[] = [];
  if (complete && regularWeeks.length > 0) {
    const present = new Set(regularWeeks);
    const first = Math.min(...regularWeeks);
    const last = Math.max(...regularWeeks);
    for (let week = first + 1; week < last; week += 1) {
      if (!present.has(week)) byes.push(week);
    }
  }

  const items: ScheduleItem[] = [];
  for (const { game } of all) {
    while (
      byes.length > 0 &&
      game.season.type === 'regular' &&
      game.week !== null &&
      (byes[0] ?? Infinity) < game.week
    ) {
      items.push({ kind: 'bye', week: byes.shift() ?? null });
    }
    items.push({ kind: 'game', game });
  }
  return items;
}

/** A game that might be in progress, and so worth checking against the live slate. */
export function inLiveWindow(game: ProviderGame, now: number): boolean {
  if (game.status === 'live') return true;
  // A TBD kickoff's time is a midnight placeholder, not a real kickoff.
  if (game.kickoffTbd) return false;
  if (
    game.status !== 'scheduled' &&
    game.status !== 'delayed' &&
    game.status !== 'suspended' &&
    game.status !== 'unknown'
  ) {
    return false;
  }
  const kickoff = Date.parse(game.kickoffUtc);
  return kickoff <= now && now - kickoff <= LIVE_WINDOW_MS;
}
