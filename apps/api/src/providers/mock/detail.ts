import type {
  GameDetail,
  GameSituation,
  LeaderRow,
  LineScore,
  ScoringPlay,
  TeamStatRow,
  WinProbability,
} from '@cfb/shared';
import type { ProviderCompetitor, ProviderGame } from '../types';
import { GAME_LENGTH, finalScores, hash } from './generate';

/**
 * Inside a mock game (context/plan-matchup-board.md, Phase 3): a line score,
 * stats, leaders, scoring plays, a drive, a down-and-distance line, and a win
 * probability, all synthetic and all labelled so.
 *
 * Deterministic in (game, now), and built on the same arithmetic as the mock
 * score: a live game's line score sums to the score the header shows at the
 * same instant, and every number moves with the clock, so polling can be seen
 * working on a Tuesday.
 */

export const MOCK_WIN_PROBABILITY_LABEL = 'Mock win probability (synthetic data)';
const MOCK_PLAY = 'Mock play (synthetic data)';

/** How far through the game `now` is: 0 at kickoff, 1 at the final whistle. */
function fractionOf(game: ProviderGame, now: number): number {
  const elapsed = now - Date.parse(game.kickoffUtc);
  return Math.min(1, Math.max(0, elapsed / GAME_LENGTH));
}

/** A mock score at a point in the game: the same formula `generate.ts` uses. */
function scoreAt(final: number, fraction: number): number {
  return Math.floor(final * fraction);
}

function isInProgress(game: ProviderGame): boolean {
  return game.status === 'live';
}

const ORDINAL = ['1st', '2nd', '3rd', '4th'];

// ─── Line score ──────────────────────────────────────────────────────────────

function lineScoreOf(game: ProviderGame, fraction: number): LineScore {
  const [home, away] = finalScores(game.providerGameId);
  const current = game.status === 'final' ? 4 : Math.min(4, Math.floor(fraction * 4) + 1);
  const at = game.status === 'final' ? 1 : fraction;
  const periods = Array.from({ length: current }, (_, index) => {
    const number = index + 1;
    const start = index / 4;
    const end = number === current ? at : number / 4;
    return {
      number,
      label: String(number),
      home: scoreAt(home, end) - scoreAt(home, start),
      away: scoreAt(away, end) - scoreAt(away, start),
    };
  });
  return { periods, homeTotal: game.home.score, awayTotal: game.away.score };
}

// ─── Scoring plays ───────────────────────────────────────────────────────────

/** Points in one period → plays: touchdowns, field goals, then whatever is left. */
function playsFor(points: number): { kind: string; value: number }[] {
  const plays: { kind: string; value: number }[] = [];
  let left = points;
  while (left >= 7) {
    plays.push({ kind: 'TD', value: 7 });
    left -= 7;
  }
  while (left >= 3) {
    plays.push({ kind: 'FG', value: 3 });
    left -= 3;
  }
  while (left >= 2) {
    plays.push({ kind: 'SF', value: 2 });
    left -= 2;
  }
  if (left === 1) plays.push({ kind: 'PAT', value: 1 });
  return plays;
}

const PLAY_WORDS: Record<string, string> = {
  TD: 'Mock touchdown (synthetic data)',
  FG: 'Mock field goal (synthetic data)',
  SF: 'Mock safety (synthetic data)',
  PAT: 'Mock extra point (synthetic data)',
};

function clockText(secondsLeft: number): string {
  const minutes = Math.floor(secondsLeft / 60);
  return `${String(minutes)}:${String(secondsLeft % 60).padStart(2, '0')}`;
}

function scoringPlaysOf(game: ProviderGame, line: LineScore, fraction: number): ScoringPlay[] {
  const plays: ScoringPlay[] = [];
  let home = 0;
  let away = 0;
  for (const period of line.periods) {
    const events = [
      ...playsFor(period.home ?? 0).map((play) => ({ ...play, side: 'home' as const })),
      ...playsFor(period.away ?? 0).map((play) => ({ ...play, side: 'away' as const })),
    ].sort(
      (a, b) =>
        hash(`${game.providerGameId}:${String(period.number)}:${a.side}:${a.kind}`) -
        hash(`${game.providerGameId}:${String(period.number)}:${b.side}:${b.kind}`),
    );
    events.forEach((event, index) => {
      if (event.side === 'home') home += event.value;
      else away += event.value;
      const team = event.side === 'home' ? game.home.team : game.away.team;
      // Spread through the part of the period played, earliest first; the
      // clock counts down, and never past where the game clock is now.
      const played = Math.min(
        900,
        Math.max(0, Math.round((fraction * 60 - (period.number - 1) * 15) * 60)),
      );
      const secondsLeft = Math.max(
        0,
        900 - Math.round(((index + 1) * played) / (events.length + 1)),
      );
      plays.push({
        id: `${game.providerGameId}${String(period.number)}${String(index).padStart(2, '0')}`,
        period: period.number,
        clock: clockText(secondsLeft),
        teamId: team.providerTeamId,
        kind: event.kind,
        text: PLAY_WORDS[event.kind] ?? MOCK_PLAY,
        homeScore: home,
        awayScore: away,
      });
    });
  }
  return plays;
}

// ─── Stats and leaders ───────────────────────────────────────────────────────

function stat(display: string, value: number): { display: string; value: number } {
  return { display, value };
}

function gameStatsOf(game: ProviderGame, fraction: number): TeamStatRow[] {
  const side = (competitor: ProviderCompetitor) => {
    const seed = hash(`stats:${game.providerGameId}:${competitor.team.providerTeamId}`);
    const firstDowns = Math.round(fraction * (14 + (seed % 12)));
    const thirdAttempts = Math.round(fraction * (10 + (seed % 6)));
    const thirdMade = Math.floor(thirdAttempts * 0.4);
    const total = Math.round(fraction * (280 + (seed % 220)));
    const passing = Math.round(total * (0.45 + (seed % 20) / 100));
    const turnovers = Math.floor(fraction * (seed % 4));
    const possession = Math.round(fraction * 60 * 60 * (0.4 + (seed % 20) / 100));
    return {
      firstDowns: stat(String(firstDowns), firstDowns),
      thirdDownEff: { display: `${String(thirdMade)}-${String(thirdAttempts)}`, value: null },
      totalYards: stat(String(total), total),
      netPassingYards: stat(String(passing), passing),
      rushingYards: stat(String(total - passing), total - passing),
      turnovers: stat(String(turnovers), turnovers),
      possessionTime: stat(clockText(possession), possession),
    };
  };
  const home = side(game.home);
  const away = side(game.away);
  const labels: [keyof typeof home, string][] = [
    ['firstDowns', '1st Downs'],
    ['thirdDownEff', '3rd down efficiency'],
    ['totalYards', 'Total Yards'],
    ['netPassingYards', 'Passing'],
    ['rushingYards', 'Rushing'],
    ['turnovers', 'Turnovers'],
    ['possessionTime', 'Possession'],
  ];
  return labels.map(([key, label]) => ({ key, label, home: home[key], away: away[key] }));
}

function seasonAveragesOf(game: ProviderGame): TeamStatRow[] {
  const side = (competitor: ProviderCompetitor) => {
    const seed = hash(`season:${competitor.team.providerTeamId}`);
    const points = 18 + (seed % 25) + ((seed >>> 8) % 10) / 10;
    const yards = 320 + (seed % 180) + ((seed >>> 4) % 10) / 10;
    const allowed = 14 + ((seed >>> 12) % 20) + ((seed >>> 16) % 10) / 10;
    return {
      totalPointsPerGame: stat(points.toFixed(1), points),
      yardsPerGame: stat(yards.toFixed(1), yards),
      totalPointsPerGameAllowed: stat(allowed.toFixed(1), allowed),
    };
  };
  const home = side(game.home);
  const away = side(game.away);
  const labels: [keyof typeof home, string][] = [
    ['totalPointsPerGame', 'Points Per Game'],
    ['yardsPerGame', 'Total Yards'],
    ['totalPointsPerGameAllowed', 'Points Allowed Per Game'],
  ];
  return labels.map(([key, label]) => ({ key, label, home: home[key], away: away[key] }));
}

function leadersOf(game: ProviderGame, fraction: number, season: boolean): LeaderRow[] {
  const scale = season ? 5 : fraction;
  const leader = (competitor: ProviderCompetitor, role: string, line: (seed: number) => string) => {
    const seed = hash(`leader:${role}:${game.providerGameId}:${competitor.team.providerTeamId}`);
    const abbr = competitor.team.abbreviation ?? competitor.team.name;
    return { name: `Mock ${role} (${abbr})`, line: line(seed) };
  };
  const passing = (seed: number): string => {
    const attempts = Math.round(scale * (28 + (seed % 14)));
    const completions = Math.round(attempts * 0.62);
    const yards = Math.round(scale * (180 + (seed % 160)));
    const touchdowns = Math.floor(scale * (seed % 4));
    return `${String(completions)}/${String(attempts)}, ${String(yards)} YDS, ${String(touchdowns)} TD`;
  };
  const rushing = (seed: number): string =>
    `${String(Math.round(scale * (12 + (seed % 12))))} CAR, ${String(Math.round(scale * (50 + (seed % 90))))} YDS`;
  const receiving = (seed: number): string =>
    `${String(Math.round(scale * (3 + (seed % 7))))} REC, ${String(Math.round(scale * (40 + (seed % 90))))} YDS`;
  return [
    {
      category: 'passing',
      label: 'Passing',
      home: leader(game.home, 'passer', passing),
      away: leader(game.away, 'passer', passing),
    },
    {
      category: 'rushing',
      label: 'Rushing',
      home: leader(game.home, 'rusher', rushing),
      away: leader(game.away, 'rusher', rushing),
    },
    {
      category: 'receiving',
      label: 'Receiving',
      home: leader(game.home, 'receiver', receiving),
      away: leader(game.away, 'receiver', receiving),
    },
  ];
}

// ─── Live only: drive, situation, win probability ────────────────────────────

/** Each mock drive lasts three game minutes; the ball changes hands between them. */
const DRIVE_MINUTES = 3;

function hasBall(game: ProviderGame, fraction: number): ProviderCompetitor {
  const drive = Math.floor((fraction * 60) / DRIVE_MINUTES);
  const homeFirst = hash(`toss:${game.providerGameId}`) % 2 === 0;
  return (drive % 2 === 0) === homeFirst ? game.home : game.away;
}

/**
 * Down, distance, and possession for a live mock game. They change with the
 * game clock, roughly every play, so a poll shows them moving.
 */
export function mockSituation(game: ProviderGame, now: number): GameSituation | null {
  if (!isInProgress(game)) return null;
  const fraction = fractionOf(game, now);
  const offense = hasBall(game, fraction);
  const play = Math.floor(fraction * 60 * 2);
  const seed = hash(`situation:${game.providerGameId}:${String(play)}`);
  const down = (play % 4) + 1;
  const distance = 1 + (seed % 10);
  const yardLine = 5 + ((seed >>> 8) % 45);
  const side = (seed >>> 4) % 2 === 0 ? offense : offense === game.home ? game.away : game.home;
  const marker = side.team.abbreviation ?? side.team.name;
  return {
    possessionTeamId: offense.team.providerTeamId,
    downDistance: `${ORDINAL[down - 1] ?? `${String(down)}th`} & ${String(distance)} at ${marker} ${String(yardLine)}`,
    lastPlay: MOCK_PLAY,
  };
}

function winProbabilityOf(game: ProviderGame, fraction: number): WinProbability {
  const [home, away] = finalScores(game.providerGameId);
  const lean = ((hash(`lean:${game.providerGameId}`) % 100) - 50) / 100;
  // One point per two game minutes played, and one for now.
  const steps = Math.max(1, Math.floor((fraction * 60) / 2));
  const series = Array.from({ length: steps + 1 }, (_, index) => {
    const at = Math.min(fraction, (index * 2) / 60);
    const margin = scoreAt(home, at) - scoreAt(away, at);
    const logit = lean + margin * 0.12 * (0.5 + at * 2);
    return Math.round((1 / (1 + Math.exp(-logit))) * 10_000) / 10_000;
  });
  const latest = series.at(-1) ?? 0.5;
  return {
    source: 'mock_win_probability',
    sourceLabel: MOCK_WIN_PROBABILITY_LABEL,
    homeWinProbability: latest,
    awayWinProbability: Math.round((1 - latest) * 10_000) / 10_000,
    tieProbability: 0,
    homeSeries: series,
  };
}

// ─── The whole detail ────────────────────────────────────────────────────────

export function mockGameDetail(game: ProviderGame, now: number): GameDetail {
  const live = isInProgress(game);
  const kickedOff = live || game.status === 'final';
  const fraction = game.status === 'final' ? 1 : fractionOf(game, now);
  const settled = game.status === 'postponed' || game.status === 'canceled';

  const lineScore = kickedOff ? lineScoreOf(game, fraction) : null;
  const offense = live ? hasBall(game, fraction) : null;
  const drivePlays = 1 + (Math.floor(fraction * 60 * 2) % (DRIVE_MINUTES * 2));
  const driveSeconds = Math.round(((fraction * 60) % DRIVE_MINUTES) * 60);

  return {
    providerGameId: game.providerGameId,
    status: game.status,
    kickoffUtc: game.kickoffUtc,
    kickoffTbd: game.kickoffTbd,
    lineScore,
    statsKind: kickedOff ? 'game' : 'season_average',
    // A postponed or canceled mock game publishes nothing, as ESPN's do.
    teamStats: kickedOff ? gameStatsOf(game, fraction) : settled ? [] : seasonAveragesOf(game),
    leaders: settled ? [] : leadersOf(game, fraction, !kickedOff),
    scoringPlays: lineScore === null ? [] : scoringPlaysOf(game, lineScore, fraction),
    currentDrive:
      offense === null
        ? null
        : {
            teamId: offense.team.providerTeamId,
            description: `${String(drivePlays)} plays, ${String(drivePlays * 4)} yards, ${clockText(driveSeconds)}`,
          },
    winProbability: live ? winProbabilityOf(game, fraction) : null,
  };
}
