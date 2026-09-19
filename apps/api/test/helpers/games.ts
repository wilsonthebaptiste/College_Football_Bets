import type { GameStatus, Season, TeamRecord } from '@cfb/shared';
import type { ProviderCompetitor, ProviderGame } from '../../src/providers/types';

/** Builders for provider-layer games, for derivation tests that need exact control. */

export const US = '100';
export const SEASON: Season = { year: 2026, type: 'regular', week: null };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const NOW = Date.parse('2026-10-07T12:00:00Z'); // a Wednesday
export const hoursFromNow = (hours: number): string => new Date(NOW + hours * HOUR).toISOString();
export const daysFromNow = (days: number): string => new Date(NOW + days * DAY).toISOString();

export function record(summary: string): TeamRecord {
  const [wins = 0, losses = 0] = summary.split('-').map(Number);
  return { wins, losses, ties: null, summary, conference: null };
}

function competitor(
  id: string,
  score: number | null,
  winner: boolean | null,
  rec: TeamRecord | null,
): ProviderCompetitor {
  return {
    team: { providerTeamId: id, name: `Team ${id}`, abbreviation: `T${id}`, logoUrl: null },
    score,
    winner,
    record: rec,
  };
}

export interface GameSpec {
  id?: string;
  week: number | null;
  kickoff: string;
  status?: GameStatus;
  opponent?: string;
  home?: boolean;
  us?: number;
  them?: number;
  /** Our record as reported on this game. */
  record?: TeamRecord | null;
  neutral?: boolean;
  tbd?: boolean;
  seasonType?: Season['type'];
}

export function game(spec: GameSpec): ProviderGame {
  const status = spec.status ?? 'scheduled';
  const final = status === 'final';
  const scored = final || status === 'live';
  const us = scored ? (spec.us ?? 0) : null;
  const them = scored ? (spec.them ?? 0) : null;
  const ourWin = final ? (us ?? 0) > (them ?? 0) : null;
  const theirWin = final ? (them ?? 0) > (us ?? 0) : null;
  const ours = competitor(US, us, ourWin, spec.record ?? null);
  const theirs = competitor(spec.opponent ?? `opp${String(spec.week)}`, them, theirWin, null);
  const home = spec.home ?? true;
  return {
    providerGameId: spec.id ?? `g${String(spec.week)}-${spec.kickoff}`,
    season: { ...SEASON, type: spec.seasonType ?? 'regular', week: spec.week },
    week: spec.week,
    kickoffUtc: spec.kickoff,
    kickoffTbd: spec.tbd ?? false,
    status,
    statusDetail: status === 'scheduled' ? null : status,
    period: status === 'live' ? 2 : null,
    clock: status === 'live' ? '7:00' : null,
    neutralSite: spec.neutral ?? false,
    venue: null,
    broadcast: null,
    home: home ? ours : theirs,
    away: home ? theirs : ours,
  };
}
