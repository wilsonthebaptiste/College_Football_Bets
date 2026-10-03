import type {
  GameResult,
  Matchup,
  MatchupBoardResponse,
  MatchupOwner,
  MatchupSide,
  Season,
  SeasonWeek,
} from '@cfb/shared';
import { formatGameDay, gameDayKey, teamLabel, type ClockOptions } from './format';

/**
 * Every rule a matchup screen applies to the API's rows, in one place
 * (plan-matchup-board, Phase 2), so the board, its cards, and the game page
 * cannot disagree, and each rule is unit-tested without rendering anything.
 */

/**
 * Kicked off and not over, including a mid-game delay or suspension. The same
 * rule the server's ordering uses (`services/matchups.ts`), so a row is never
 * in "Live now" on one side of the wire and "Upcoming" on the other.
 */
export function isInProgress(row: Pick<Matchup, 'status' | 'period'>): boolean {
  if (row.status === 'live') return true;
  return (row.status === 'delayed' || row.status === 'suspended') && row.period !== null;
}

export type MatchupSection = 'live' | 'upcoming' | 'final' | 'off';

export function sectionOf(row: Pick<Matchup, 'status' | 'period'>): MatchupSection {
  if (isInProgress(row)) return 'live';
  if (row.status === 'final') return 'final';
  if (row.status === 'postponed' || row.status === 'canceled') return 'off';
  return 'upcoming';
}

export interface DayGroup {
  /** `YYYY-MM-DD` in the viewer's zone, or `'unknown'` for a kickoff that is not a date. */
  key: string;
  /** `Saturday, October 3`. */
  label: string;
  rows: Matchup[];
}

export interface MatchupSections {
  live: Matchup[];
  /** Grouped by day in the VIEWER's zone, days in order, the server's order kept within a day. */
  upcoming: DayGroup[];
  final: Matchup[];
  off: Matchup[];
}

/**
 * The board's four sections. The server orders upcoming games by its own
 * slate day (US Eastern for ESPN); a viewer elsewhere sees a late Saturday
 * kickoff on Sunday, so the days are regrouped here, through `Intl`, and the
 * server's order is kept inside each one — which is what keeps a TBD kickoff
 * last within its day.
 */
export function groupMatchups(
  rows: readonly Matchup[],
  options: Pick<ClockOptions, 'timeZone'> = {},
): MatchupSections {
  const sections: MatchupSections = { live: [], upcoming: [], final: [], off: [] };
  const days = new Map<string, Matchup[]>();
  for (const row of rows) {
    const section = sectionOf(row);
    if (section !== 'upcoming') {
      sections[section].push(row);
      continue;
    }
    const key = gameDayKey(row, options) ?? 'unknown';
    const day = days.get(key);
    if (day === undefined) days.set(key, [row]);
    else day.push(row);
  }
  // `YYYY-MM-DD` sorts as text; a day that is not a date goes last.
  sections.upcoming = [...days.entries()]
    .sort(([a], [b]) => (a === 'unknown' ? 1 : b === 'unknown' ? -1 : a.localeCompare(b)))
    .map(([key, dayRows]) => ({
      key,
      label: key === 'unknown' ? 'Date to be announced' : formatGameDay(key),
      rows: dayRows,
    }));
  return sections;
}

/** "Ohio State at Iowa", or "Texas vs Oklahoma" at a neutral site (§19: never from list order). */
export function matchupTitle(row: Pick<Matchup, 'home' | 'away' | 'neutralSite'>): string {
  const joiner = row.neutralSite ? 'vs' : 'at';
  return `${teamLabel(row.away.team)} ${joiner} ${teamLabel(row.home.team)}`;
}

function possessive(name: string): string {
  return `${name}'s`;
}

/** Owners on both sides, by user id (two people may share a display name), sorted by name. */
export function sharedOwners(row: Pick<Matchup, 'home' | 'away'>): MatchupOwner[] {
  const home = new Set(row.home.owners.map((owner) => owner.userId));
  return row.away.owners
    .filter((owner) => home.has(owner.userId))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * "Both Wilson's" — said in words, never by an icon alone (plan, Phase 2).
 * `null` when no one has both sides. Two people with both sides (possible
 * when boards share teams, as the seed's do) read "Both Jordan's and Wilson's".
 */
export function sameOwnerNote(row: Pick<Matchup, 'home' | 'away' | 'sameOwner'>): string | null {
  if (!row.sameOwner) return null;
  const names = sharedOwners(row).map((owner) => possessive(owner.displayName));
  if (names.length === 0) return null;
  if (names.length === 1) return `Both ${names[0] ?? ''}`;
  return `Both ${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/**
 * A side's result, only once the provider says final. A loser is marked only
 * when the other side is the provider's named winner: two `false`s are a gap
 * in the data, not a tie, and a tie is never inferred (§4).
 */
export function resultOf(
  row: Pick<Matchup, 'status' | 'home' | 'away'>,
  side: 'home' | 'away',
): GameResult | null {
  if (row.status !== 'final') return null;
  const own = row[side];
  const other = row[side === 'home' ? 'away' : 'home'];
  if (own.winner === true) return 'W';
  if (other.winner === true) return 'L';
  return null;
}

/**
 * What a card can say about the score:
 *
 * - `scores`: both numbers, for a game in progress or final.
 * - `missing`: in progress or final, but the provider sent no score — "Score
 *   unavailable", never 0–0 (§4).
 * - `failed`: the row's own data could not be read — "Score temporarily
 *   unavailable", with both teams still named.
 * - `none`: nothing to score yet (upcoming, postponed, canceled).
 */
export type ScoreState = 'scores' | 'missing' | 'failed' | 'none';

export function scoreState(row: Matchup): ScoreState {
  if (row.freshness.state === 'unavailable') return 'failed';
  const section = sectionOf(row);
  if (section !== 'live' && section !== 'final') return 'none';
  return row.home.score !== null && row.away.score !== null ? 'scores' : 'missing';
}

export interface BoardFreshness {
  /** The oldest row's `fetchedAt`, or the week's own when there are no rows. */
  oldestFetchedAt: string | null;
  anyStale: boolean;
}

/**
 * The header's honest "Last updated" (the board's rule, `lib/freshness.ts`):
 * the OLDEST row's time, so a fresh live slate cannot make an hour-old week
 * look current, and stale if the week or any row is.
 */
export function summarizeMatchupFreshness(
  board: Pick<MatchupBoardResponse, 'freshness' | 'matchups'>,
): BoardFreshness {
  let oldest: { iso: string; ms: number } | null = null;
  let anyStale = board.freshness.state === 'stale';
  for (const row of board.matchups) {
    const { state, fetchedAt } = row.freshness;
    if (state === 'stale') anyStale = true;
    if (state === 'unavailable' || fetchedAt === null) continue;
    const ms = Date.parse(fetchedAt);
    if (!Number.isNaN(ms) && (oldest === null || ms < oldest.ms)) oldest = { iso: fetchedAt, ms };
  }
  return {
    oldestFetchedAt:
      oldest?.iso ?? (board.matchups.length === 0 ? board.freshness.fetchedAt : null),
    anyStale,
  };
}

/** The poll the ranks come from, once for the page (§7). `null` when nobody is ranked. */
export function rankingPollOfMatchups(rows: readonly Matchup[]): string | null {
  for (const row of rows) {
    for (const side of [row.away, row.home]) {
      if (side.ranking.kind === 'ranked') return side.ranking.poll;
    }
  }
  return null;
}

/**
 * A week's name. The provider's own label when the calendar lists the week —
 * ESPN's postseason weeks are `1` "Bowls" and `999` "CFP", so "Week {n}" would
 * be wrong there. With no calendar, a regular-season number is still a week.
 */
export function weekLabel(season: Season, week: number, weeks: readonly SeasonWeek[]): string {
  const listed = weeks.find((entry) => entry.week === week);
  if (listed !== undefined && listed.label.trim() !== '') return listed.label;
  return season.type === 'postseason' ? 'Postseason' : `Week ${String(week)}`;
}

/** The weeks either side of `week` in the calendar's own order. Both `null` with no calendar. */
export function adjacentWeeks(
  week: number | null,
  weeks: readonly SeasonWeek[],
): { previous: SeasonWeek | null; next: SeasonWeek | null } {
  const index = week === null ? -1 : weeks.findIndex((entry) => entry.week === week);
  if (index < 0) return { previous: null, next: null };
  return { previous: weeks[index - 1] ?? null, next: weeks[index + 1] ?? null };
}

/** The board for one week. A real `?week=` link, so the back button works (§47). */
export function weekPath(week: number): string {
  return `/matchups?week=${String(week)}`;
}

/** The game page's address. The provider's game id, as `/api/games/:gameId` takes it. */
export function matchupPath(providerGameId: string): string {
  return `/matchups/${encodeURIComponent(providerGameId)}`;
}

/**
 * A side's team page: our uuid when the team has a row (every owned side
 * does), else the provider's id, which the team route also accepts.
 */
export function teamPath(side: MatchupSide): string {
  return `/teams/${encodeURIComponent(side.team.id ?? side.team.providerTeamId)}`;
}
