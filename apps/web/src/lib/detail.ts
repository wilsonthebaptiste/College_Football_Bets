import type {
  GameDetail,
  GameStatsKind,
  Matchup,
  MatchupSide,
  ScoringPlay,
  StatValue,
  WinProbability,
} from '@cfb/shared';
import { formatPercent, teamLabel } from './format';
import { isInProgress } from './matchup';

/**
 * Every rule the game page applies to what is inside a game
 * (plan-matchup-board, Phase 3), pure and unit-tested. Every value printed is
 * the API's own display string; a missing one is `—`, never `0`, and nothing
 * here computes a figure the provider did not publish.
 */

/** The dash a missing value prints as. Never `0`, which would be a fact (§4). */
export const MISSING = '—';

/** A side's shortest honest name: its abbreviation, else its name. */
export function sideShortName(side: MatchupSide): string {
  return side.team.abbreviation ?? teamLabel(side.team);
}

/** Which side has the ball, by provider team id. `null` when not reported or not live. */
export function possessionSide(
  row: Pick<Matchup, 'situation' | 'status' | 'period' | 'home' | 'away'>,
): 'home' | 'away' | null {
  if (!isInProgress(row)) return null;
  const id = row.situation?.possessionTeamId ?? null;
  if (id === null) return null;
  if (id === row.home.team.providerTeamId) return 'home';
  if (id === row.away.team.providerTeamId) return 'away';
  return null;
}

/**
 * The header's situation line while live: "UNLV ball, 1st & 10 at UNLV 48".
 * Possession in words, never a dot alone. `null` when there is nothing to
 * say, including a row the slate could not check (it carries no situation).
 */
export function situationLine(row: Matchup): string | null {
  if (!isInProgress(row) || row.situation === null) return null;
  const side = possessionSide(row);
  const ball = side === null ? null : `${sideShortName(row[side])} ball`;
  const parts = [ball, row.situation.downDistance].filter(
    (part): part is string => part !== null && part.trim() !== '',
  );
  return parts.length === 0 ? null : parts.join(', ');
}

export function statText(value: StatValue): string {
  return value.display ?? MISSING;
}

export function pointsText(points: number | null): string {
  return points === null ? MISSING : String(points);
}

/** A 0–1 probability as the screen prints it: "92.3%". */
export function probabilityText(probability: number): string {
  return formatPercent(Math.round(probability * 1000) / 10);
}

export function statsTitle(kind: GameStatsKind): string {
  return kind === 'game' ? 'Team stats' : 'Season averages';
}

export function leadersTitle(kind: GameStatsKind): string {
  return kind === 'game' ? 'Leaders' : 'Season leaders';
}

/** "Q1"…"Q4", then "OT", "2OT". */
export function periodShort(period: number | null): string | null {
  if (period === null) return null;
  if (period <= 4) return `Q${String(period)}`;
  return period === 5 ? 'OT' : `${String(period - 4)}OT`;
}

const ORDINALS = ['1st', '2nd', '3rd', '4th'];

/** "4th quarter", "overtime", "2nd overtime": what a screen reader hears for `periodShort`. */
export function periodSpoken(period: number | null): string | null {
  if (period === null) return null;
  if (period <= 4) return `${ORDINALS[period - 1] ?? String(period)} quarter`;
  return period === 5 ? 'overtime' : `${ORDINALS[period - 5] ?? String(period - 4)} overtime`;
}

/** The side that scored, if the play names one of this game's teams. */
export function sideOfTeam(row: Pick<Matchup, 'home' | 'away'>, teamId: string | null) {
  if (teamId === null) return null;
  if (teamId === row.home.team.providerTeamId) return row.home;
  if (teamId === row.away.team.providerTeamId) return row.away;
  return null;
}

/** "Cal 25, UNLV 32", away first as the page reads. `null` when the provider sent no score. */
export function scoreAfter(row: Pick<Matchup, 'home' | 'away'>, play: ScoringPlay): string | null {
  if (play.homeScore === null || play.awayScore === null) return null;
  return `${sideShortName(row.away)} ${String(play.awayScore)}, ${sideShortName(row.home)} ${String(play.homeScore)}`;
}

/**
 * Newest first while the game is on (what just happened matters most, §51),
 * in game order once it is over.
 */
export function orderedScoringPlays(
  plays: readonly ScoringPlay[],
  row: Pick<Matchup, 'status' | 'period'>,
): ScoringPlay[] {
  return isInProgress(row) ? [...plays].reverse() : [...plays];
}

/**
 * The live win probability is shown only while BOTH the header and the
 * detail say the game is on: the detail can lag the header by a poll, and a
 * live probability beside a "Final" header is a number about a decided game.
 */
export function liveWinProbability(row: Matchup, detail: GameDetail): WinProbability | null {
  if (!isInProgress(row) || detail.status === 'final' || detail.status === 'canceled') return null;
  return detail.winProbability;
}

/**
 * The trend in words, beside the line that draws it: "UNLV: 51.2% after the
 * first play, 92.3% now". `null` with fewer than two points.
 */
export function trendSummary(row: Matchup, probability: WinProbability): string | null {
  const first = probability.homeSeries[0];
  if (first === undefined || probability.homeSeries.length < 2) return null;
  return `${sideShortName(row.home)}: ${probabilityText(first)} after the first play, ${probabilityText(probability.homeWinProbability)} now`;
}

/**
 * The series as SVG polyline points in a 100 × 40 box, home's chance up. Pure
 * geometry for a decorative line; the numbers are always in text beside it.
 */
export function trendPoints(series: readonly number[]): string {
  if (series.length < 2) return '';
  const step = 100 / (series.length - 1);
  return series
    .map((value, index) => {
      const x = Math.round(index * step * 100) / 100;
      const y = Math.round((1 - Math.min(1, Math.max(0, value))) * 40 * 100) / 100;
      return `${String(x)},${String(y)}`;
    })
    .join(' ');
}
