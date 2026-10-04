import type { GameStatus } from './game';

/**
 * Inside one game (context/plan-matchup-board.md, Phase 3): the line score, the
 * team stats, the leaders, the scoring plays, the current drive, and the
 * provider's in-game win probability.
 *
 * Every value a screen prints arrives here as the provider's own display
 * string. Nothing in this module is computed by us: a missing value is `null`
 * (rendered `—`), never `0`, and a probability the provider does not publish
 * is `null` (rendered "unavailable"), never estimated (§4, §46).
 */

/**
 * Down, distance, and possession while a game is live. These are not in the
 * game summary; they come from the day's live slate, the same read that
 * supplies the live score, so they are exactly as old as that score.
 */
export interface GameSituation {
  /** The provider team id of the side with the ball. `null` when not reported. */
  possessionTeamId: string | null;
  /** The provider's own words: "2nd & 7 at MIA 34". */
  downDistance: string | null;
  /** The provider's description of the last play, verbatim. */
  lastPlay: string | null;
}

/**
 * Before kickoff the provider's box score holds each team's season per-game
 * averages, under different stat names. They are a different measurement
 * from a game's own numbers and are never shown in a game column (project-notes
 * §12: two numbers that look alike can measure different things).
 */
export type GameStatsKind = 'game' | 'season_average';

/** One cell of the stats table: the provider's string, and a number only where one exists. */
export interface StatValue {
  /** Verbatim: "5-14", "33:12", "6.4". `null` when the provider sent none. */
  display: string | null;
  /** Present only when the provider sent a finite number. Never parsed from `display`. */
  value: number | null;
}

/** A row of the team-stats comparison, read from the provider BY NAME, never by position. */
export interface TeamStatRow {
  /** Our stable key: the provider's stat name. */
  key: string;
  /** The provider's own label ("3rd down efficiency"), else ours. */
  label: string;
  home: StatValue;
  away: StatValue;
}

/** Points in one period. Overtime periods are numbered on from 5. */
export interface LinePeriod {
  /** 1–4 for quarters, 5 and up for overtime. */
  number: number;
  /** "1", "2", "3", "4", "OT", "2OT"… */
  label: string;
  home: number | null;
  away: number | null;
}

export interface LineScore {
  periods: LinePeriod[];
  /** The provider's own total for each side, never a sum we made. */
  homeTotal: number | null;
  awayTotal: number | null;
}

export type LeaderCategory = 'passing' | 'rushing' | 'receiving';

export interface GameLeader {
  /** The athlete's name as the provider prints it. */
  name: string;
  /** The provider's stat line, verbatim: "18/24, 231 YDS, 2 TD". */
  line: string;
}

export interface LeaderRow {
  category: LeaderCategory;
  /** "Passing", "Rushing", "Receiving". */
  label: string;
  home: GameLeader | null;
  away: GameLeader | null;
}

export interface ScoringPlay {
  id: string;
  period: number | null;
  /** The game clock when it happened, as the provider prints it. */
  clock: string | null;
  /** The provider team id of the side that scored. `null` when not reported. */
  teamId: string | null;
  /** "TD", "FG", "SF"… the provider's own abbreviation. */
  kind: string | null;
  /** The provider's description, verbatim. */
  text: string | null;
  /** The score after the play. */
  homeScore: number | null;
  awayScore: number | null;
}

export interface CurrentDrive {
  /** The provider team id of the side with the ball. */
  teamId: string | null;
  /** The provider's own summary: "4 plays, 26 yards, 1:30". */
  description: string;
}

export type WinProbabilitySource = 'espn_win_probability' | 'mock_win_probability';

/**
 * The provider's IN-GAME win probability: a different model from the pregame
 * predictor, and labelled differently wherever it is shown (§46).
 *
 * Probabilities are 0–1 here, divided in normalization if the provider sends
 * percentages, never later. `awayWinProbability` is the provider's when it
 * publishes one, else what is left after home and tie.
 *
 * The series' last entry can lag the score by a play. It is dated by the read
 * that fetched it (the envelope's `fetchedAt`), never called current.
 */
export interface WinProbability {
  source: WinProbabilitySource;
  /** Shown verbatim, so the model is identifiable: "ESPN win probability". */
  sourceLabel: string;
  homeWinProbability: number;
  awayWinProbability: number;
  tieProbability: number | null;
  /** The home side's probability after each play, oldest first, for a trend line. */
  homeSeries: number[];
}

export interface GameDetail {
  providerGameId: string;
  /** The game's status as the detail read saw it. It can lag the header by a poll. */
  status: GameStatus;
  /** §20 — ISO 8601 UTC. What the server's cache lifetime is chosen from near kickoff. */
  kickoffUtc: string;
  kickoffTbd: boolean;
  /** `null` before kickoff, and whenever the provider sends no per-period points. */
  lineScore: LineScore | null;
  statsKind: GameStatsKind;
  /** Empty when the provider published no stats at all. */
  teamStats: TeamStatRow[];
  /** Season leaders before kickoff (`statsKind: 'season_average'`), game leaders after. */
  leaders: LeaderRow[];
  /** In game order. Empty before kickoff. */
  scoringPlays: ScoringPlay[];
  /** Live only. */
  currentDrive: CurrentDrive | null;
  /** Live only: `null` before kickoff, when the series is empty, and for a final game. */
  winProbability: WinProbability | null;
}
