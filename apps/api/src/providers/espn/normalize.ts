import type {
  GameDetail,
  GameLeader,
  GameSituation,
  GameStatus,
  LeaderCategory,
  LeaderRow,
  LineScore,
  Prediction,
  PredictionSide,
  RankedTeam,
  RankingsSnapshot,
  ScoringPlay,
  Season,
  SeasonType,
  SeasonWeek,
  StatValue,
  TeamIdentity,
  TeamRecord,
  TeamRef,
  TeamStatRow,
  WinProbability,
} from '@cfb/shared';
import { resolveSeasonFromDate } from '@cfb/shared';
import type {
  FpiFieldSums,
  ProviderCompetitor,
  ProviderGame,
  ProviderSchedule,
  TeamProjectionInputs,
  TeamProjectionsDocument,
} from '../types';
import type {
  RawCalendar,
  RawCalendarWeeks,
  RawCompetitor,
  RawEvent,
  RawFpiPage,
  RawFpiTeam,
  RawGameDetail,
  RawPoll,
  RawRankings,
  RawRecordEntry,
  RawSchedule,
  RawScore,
  RawSituation,
  RawStandalonePredictor,
  RawStat,
  RawSummary,
  RawTeam,
} from './raw';
import { mapStatus } from './status-map';

/**
 * Validated ESPN shapes → the application's domain model.
 *
 * Every rule here traces back to something observed in a real payload
 * (docs/espn-notes.md) or to a spec section. Nothing here fetches, caches, or
 * throws: bad input was already turned into `null` by `validate.ts`, and a
 * `null` field becomes an explicit "unavailable" in the output.
 */

export const ESPN_PREDICTOR_LABEL = 'ESPN Matchup Predictor';

// ─── Seasons ─────────────────────────────────────────────────────────────────

/** ESPN `season.type`: 1 preseason, 2 regular, 3 postseason, 4 off season. */
export function seasonTypeFromEspn(type: number | null): SeasonType | null {
  switch (type) {
    case 1:
      return 'preseason';
    case 2:
      return 'regular';
    case 3:
    // The off season (late January) is the tail of the season just played, so
    // it maps to postseason exactly as the date heuristic in season.ts does.
    // falls through
    case 4:
      return 'postseason';
    default:
      return null;
  }
}

/**
 * Which ESPN season types make up a season's full schedule (§17).
 * Regular-season games always count; bowls are a separate request (seasontype=3)
 * and only exist once the postseason does.
 */
export function scheduleSeasonTypes(season: Season): number[] {
  return season.type === 'postseason' ? [2, 3] : [2];
}

/** The inverse of `seasonTypeFromEspn`, for building URLs: `seasontype=`. */
export function espnSeasonType(type: SeasonType): number {
  switch (type) {
    case 'preseason':
      return 1;
    case 'regular':
      return 2;
    case 'postseason':
      return 3;
  }
}

/**
 * The calendar's weeks for one season phase, in start order.
 *
 * A calendar for another year has no weeks for this season: around the
 * rollover ESPN's bare scoreboard may already describe the next one, and its
 * dates would be the wrong year's. The label falls back to "Week n" only when
 * ESPN sends none — a name for an unnamed week, as `fullName` bottoms out at
 * the team id.
 */
export function toSeasonWeeks(raw: RawCalendarWeeks, season: Season): SeasonWeek[] {
  if (raw.seasonYear !== season.year) return [];
  const phase = raw.phases.find((entry) => entry.seasonType === espnSeasonType(season.type));
  if (phase === undefined) return [];
  return phase.weeks
    .map((week) => ({
      week: week.week,
      label: week.label ?? `Week ${String(week.week)}`,
      startUtc: new Date(week.startDate).toISOString(),
      endUtc: new Date(week.endDate).toISOString(),
    }))
    .sort((a, b) => a.startUtc.localeCompare(b.startUtc) || a.week - b.week);
}

function validWeek(week: number | null): number | null {
  return week !== null && Number.isInteger(week) && week >= 0 ? week : null;
}

export function toSeason(raw: RawCalendar): Season | null {
  const type = seasonTypeFromEspn(raw.seasonType);
  if (type === null || !Number.isInteger(raw.seasonYear)) return null;
  // Type 4 (off season) has a "week 1" that means nothing to a board.
  return { year: raw.seasonYear, type, week: raw.seasonType === 4 ? null : validWeek(raw.week) };
}

// ─── Teams ───────────────────────────────────────────────────────────────────

const HEX_COLOR = /^[0-9a-f]{6}$/i;

function hexColor(value: string | null): string | null {
  return value !== null && HEX_COLOR.test(value) ? value.toLowerCase() : null;
}

/** Only https URLs reach an `<img src>`; anything else is dropped, not repaired. */
function httpsUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** `logos[]` carries light and dark variants. Prefer `default`, never index blindly. */
function pickLogo(team: RawTeam): string | null {
  const preferred = team.logos.find((logo) => logo.rel.includes('default')) ?? team.logos[0];
  return httpsUrl(preferred?.href ?? team.logo);
}

function joined(first: string | null, second: string | null): string | null {
  return first !== null && second !== null ? `${first} ${second}` : null;
}

/**
 * A name must be shown for every team, so this bottoms out at the id. That is a
 * label for an unnamed entity, not an invented fact.
 */
function fullName(team: RawTeam): string {
  return (
    team.displayName ??
    joined(team.location, team.name) ??
    team.shortDisplayName ??
    team.location ??
    team.abbreviation ??
    `Team ${team.id}`
  );
}

/** "Texas St" rather than "Texas State Bobcats": what a card has room for. */
function shortName(team: RawTeam): string {
  return team.shortDisplayName ?? team.location ?? fullName(team);
}

export function toTeamIdentity(team: RawTeam): TeamIdentity {
  return {
    provider: 'espn',
    providerTeamId: team.id,
    name: fullName(team),
    displayName: team.shortDisplayName ?? team.location,
    abbreviation: team.abbreviation,
    logoUrl: pickLogo(team),
    // Not in any team payload. It takes two core-API hops (espn-notes §7), and
    // the board already has it from Postgres, so it is not fetched here.
    conference: null,
    primaryColor: hexColor(team.color),
    altColor: hexColor(team.alternateColor),
  };
}

export function toTeamRef(team: RawTeam): TeamRef {
  return {
    providerTeamId: team.id,
    name: shortName(team),
    abbreviation: team.abbreviation,
    logoUrl: pickLogo(team),
  };
}

// ─── Records (§8) ────────────────────────────────────────────────────────────

/**
 * A prefix match, so "7-4-1" keeps its tie and an annotated string such as
 * "9-3 (2 vacated)" still yields its parts. The full string is kept verbatim
 * for display either way.
 */
const RECORD_PREFIX = /^\s*(\d{1,3})-(\d{1,3})(?:-(\d{1,3}))?/;

export function toRecord(entries: RawRecordEntry[]): TeamRecord | null {
  const total = entries.find((entry) => entry.type === 'total');
  const summary = total?.summary ?? null;
  if (summary === null) return null;
  const match = RECORD_PREFIX.exec(summary);
  if (match === null) return null;

  const conferenceSummary = entries.find((entry) => entry.type === 'vsconf')?.summary ?? null;
  const conferenceMatch = conferenceSummary === null ? null : RECORD_PREFIX.exec(conferenceSummary);

  return {
    wins: Number(match[1]),
    losses: Number(match[2]),
    // Absent from the string means "not reported", which is not the same as 0.
    ties: match[3] === undefined ? null : Number(match[3]),
    summary: summary.trim(),
    conference:
      conferenceMatch === null
        ? null
        : { wins: Number(conferenceMatch[1]), losses: Number(conferenceMatch[2]) },
  };
}

// ─── Games ───────────────────────────────────────────────────────────────────

function scoreFromText(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : null;
}

/** All three ESPN score shapes → `number | null` (espn-notes §3). */
function toScore(raw: RawScore | null): number | null {
  if (raw === null) return null;
  if (raw.shape === 'string') return scoreFromText(raw.text);
  if (raw.value !== null && Number.isInteger(raw.value) && raw.value >= 0) return raw.value;
  return scoreFromText(raw.displayValue);
}

/** A game that has kicked off and not finished, including a mid-game delay. */
function inProgress(status: GameStatus, period: number | null): boolean {
  if (status === 'live') return true;
  return (status === 'delayed' || status === 'suspended') && period !== null && period >= 1;
}

interface Verdict {
  status: GameStatus;
  homeWinner: boolean | null;
  awayWinner: boolean | null;
}

/**
 * Enforces the §5 invariant at the source: a `final` game always has a verdict,
 * and nothing else ever does.
 *
 * The verdict comes from ESPN's `winner` flags. If they are missing on a
 * completed game, the provider's own final scores decide. That reads the
 * provider's result, it does not compute one. A final game with neither flags
 * nor scores cannot be shown truthfully, so it is downgraded to `unknown`.
 */
function verdictOf(
  status: GameStatus,
  home: RawCompetitor,
  away: RawCompetitor,
  homeScore: number | null,
  awayScore: number | null,
): Verdict {
  if (status !== 'final') return { status, homeWinner: null, awayWinner: null };

  const { winner: h } = home;
  const { winner: a } = away;
  if (h !== null && a !== null && !(h && a)) return { status, homeWinner: h, awayWinner: a };
  if (h === true && a === null) return { status, homeWinner: true, awayWinner: false };
  if (a === true && h === null) return { status, homeWinner: false, awayWinner: true };

  if (homeScore !== null && awayScore !== null) {
    return { status, homeWinner: homeScore > awayScore, awayWinner: awayScore > homeScore };
  }
  return { status: 'unknown', homeWinner: null, awayWinner: null };
}

function toCompetitor(
  raw: RawCompetitor,
  score: number | null,
  winner: boolean | null,
): ProviderCompetitor {
  return { team: toTeamRef(raw.team), score, winner, record: toRecord(raw.records) };
}

/**
 * One ESPN event (schedule, scoreboard, or summary shape) → `ProviderGame`.
 *
 * `fallbackSeason` covers an event that omits its own season. Without one, the
 * season is resolved from the kickoff date by the centralized heuristic (§21);
 * no year is ever assumed here.
 */
export function toProviderGame(raw: RawEvent, fallbackSeason?: Season): ProviderGame {
  const kickoff = new Date(raw.date);
  const fallback = fallbackSeason ?? resolveSeasonFromDate(kickoff);
  const week = validWeek(raw.week);

  const mapped = mapStatus(raw.status);
  const period = raw.status?.period ?? null;
  const live = inProgress(mapped, period);

  // A postponed game arrives with "0"–"0" and an upcoming scoreboard game with
  // "0"–"0". Neither is a score. Only live and final games have one.
  const scored = mapped === 'final' || live;
  const homeScore = scored ? toScore(raw.home.score) : null;
  const awayScore = scored ? toScore(raw.away.score) : null;
  const verdict = verdictOf(mapped, raw.home, raw.away, homeScore, awayScore);
  const status = verdict.status;
  const keepScores = status === 'final' || live;
  const situation = live ? toSituation(raw.situation) : null;

  return {
    providerGameId: raw.id,
    season: {
      year:
        raw.seasonYear !== null && Number.isInteger(raw.seasonYear)
          ? raw.seasonYear
          : fallback.year,
      type: seasonTypeFromEspn(raw.seasonType) ?? fallback.type,
      week,
    },
    week,
    // Minute precision in, full ISO 8601 UTC out (§20, espn-notes §3).
    kickoffUtc: kickoff.toISOString(),
    kickoffTbd: raw.timeValid === false,
    status,
    // A scheduled game's detail is "Sat, September 19th at 8:00 PM EDT": a
    // formatted time in one zone, which §20 keeps out of the data model. The
    // UI formats `kickoffUtc` in the viewer's own zone instead.
    statusDetail:
      status === 'scheduled' ? null : (raw.status?.detail ?? raw.status?.shortDetail ?? null),
    period: live ? period : null,
    clock: live ? (raw.status?.displayClock ?? null) : null,
    neutralSite: raw.neutralSite === true,
    venue: raw.venue,
    broadcast: raw.broadcast,
    home: toCompetitor(raw.home, keepScores ? homeScore : null, verdict.homeWinner),
    away: toCompetitor(raw.away, keepScores ? awayScore : null, verdict.awayWinner),
    // Down and distance belong to a game in progress, and only a scoreboard
    // carries them; every other read has none, and leaves the key out.
    ...(situation === null ? {} : { situation }),
  };
}

/**
 * The slate's `situation` → the down-and-distance line. ESPN's long form
 * ("2nd & 10 at MIA 34") when it sends one, else the short form.
 */
export function toSituation(raw: RawSituation | null): GameSituation | null {
  if (raw === null) return null;
  const downDistance = raw.downDistanceText ?? raw.shortDownDistanceText;
  if (raw.possession === null && downDistance === null && raw.lastPlayText === null) return null;
  return {
    possessionTeamId: raw.possession,
    downDistance,
    lastPlay: raw.lastPlayText,
  };
}

/**
 * One or more schedule payloads (regular, plus postseason once it exists) → one
 * season's schedule, in kickoff order, each game once.
 */
export function toSchedule(payloads: RawSchedule[], season: Season): ProviderSchedule {
  const byId = new Map<string, ProviderGame>();
  let droppedEvents = 0;
  for (const payload of payloads) {
    droppedEvents += payload.droppedEvents;
    for (const event of payload.events) {
      byId.set(event.id, toProviderGame(event, season));
    }
  }
  const games = [...byId.values()].sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc));
  return { season, games, droppedEvents };
}

// ─── Rankings (§7) ───────────────────────────────────────────────────────────

const POLL_FALLBACK_NAMES: Readonly<Record<string, string>> = {
  cfp: 'CFP Rankings',
  ap: 'AP Top 25',
};

function isCfpPoll(poll: RawPoll): boolean {
  return poll.type === 'cfp' || /playoff|\bcfp\b/i.test(poll.name ?? '');
}

/**
 * Plan assumption §11.4: the CFP poll once it is published (about week 10),
 * otherwise AP. The poll's OWN name is carried through, so an AP rank is never
 * labelled as CFP (§46). A poll from another season does not count (§21).
 */
export function toRankings(raw: RawRankings, season: Season): RankingsSnapshot | null {
  const usable = raw.polls.filter(
    (poll): poll is RawPoll & { ranks: NonNullable<RawPoll['ranks']> } =>
      poll.ranks !== null && poll.ranks.length > 0 && poll.seasonYear === season.year,
  );
  const poll = usable.find(isCfpPoll) ?? usable.find((candidate) => candidate.type === 'ap');
  if (poll === undefined) return null;

  const name =
    poll.name ??
    poll.shortName ??
    (isCfpPoll(poll) ? POLL_FALLBACK_NAMES['cfp'] : POLL_FALLBACK_NAMES['ap']) ??
    'Poll';

  const teams: RankedTeam[] = poll.ranks.map((rank) => ({
    rank: rank.current,
    providerTeamId: rank.team.id,
    name: fullName(rank.team),
    abbreviation: rank.team.abbreviation,
    recordSummary: rank.recordSummary,
  }));
  return { season, poll: name, week: validWeek(poll.week), teams };
}

// ─── Predictions (§12, §46) ──────────────────────────────────────────────────

function isPercentage(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** ESPN's own display precision ("82.5"); also removes float noise like 17.549999999999997. */
function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function sideOf(team: RawTeam): PredictionSide {
  return { providerTeamId: team.id, name: shortName(team), abbreviation: team.abbreviation };
}

/**
 * The inline `summary.predictor` first (no extra request); the standalone core
 * predictor when the summary has none.
 *
 * The inline block names its teams. If those ids do not match this game's
 * home and away teams, the numbers belong to some other framing, so they are
 * discarded rather than attached to the wrong side. Anything short of two
 * valid percentages is `null` → "Prediction unavailable". It is never `0%`, and
 * never odds or pickcenter (§46).
 */
export function toPrediction(
  summary: RawSummary,
  standalone: RawStandalonePredictor | null,
  retrievedAt: string,
): Prediction | null {
  const { home, away } = summary.event;
  let homePct: number | null = null;
  let awayPct: number | null = null;

  const inline = summary.predictor;
  if (
    inline !== null &&
    (inline.homeTeamId === null || inline.homeTeamId === home.team.id) &&
    (inline.awayTeamId === null || inline.awayTeamId === away.team.id)
  ) {
    homePct = inline.homeProjection;
    awayPct = inline.awayProjection;
  }
  if ((!isPercentage(homePct) || !isPercentage(awayPct)) && standalone !== null) {
    homePct = standalone.homeProjection;
    awayPct = standalone.awayProjection;
  }
  if (!isPercentage(homePct) || !isPercentage(awayPct)) return null;

  return {
    source: 'espn_matchup_predictor',
    sourceLabel: ESPN_PREDICTOR_LABEL,
    providerGameId: summary.event.id,
    homeWinPct: oneDecimal(homePct),
    awayWinPct: oneDecimal(awayPct),
    home: sideOf(home.team),
    away: sideOf(away.team),
    retrievedAt,
  };
}

/** True when a summary already carries a usable inline predictor. */
export function hasInlinePrediction(summary: RawSummary): boolean {
  return toPrediction(summary, null, new Date(0).toISOString()) !== null;
}

// ─── Inside the game (context/plan-matchup-board.md, Phase 3) ────────────────

export const ESPN_WIN_PROBABILITY_LABEL = 'ESPN win probability';

/**
 * The stats this application shows, BY NAME, each with a label of our own for
 * when ESPN sends none. Before kickoff the same `boxscore.teams[].statistics`
 * holds season per-game averages under different names (espn-notes §14), so
 * the two lists are separate, and reading each by name is what keeps an
 * average out of a game column.
 */
const GAME_STATS: readonly (readonly [string, string])[] = [
  ['firstDowns', '1st Downs'],
  ['thirdDownEff', '3rd down efficiency'],
  ['fourthDownEff', '4th down efficiency'],
  ['totalYards', 'Total Yards'],
  ['netPassingYards', 'Passing'],
  ['completionAttempts', 'Comp/Att'],
  ['yardsPerPass', 'Yards per pass'],
  ['rushingYards', 'Rushing'],
  ['rushingAttempts', 'Rushing Attempts'],
  ['yardsPerRushAttempt', 'Yards per rush'],
  ['totalPenaltiesYards', 'Penalties'],
  ['turnovers', 'Turnovers'],
  ['fumblesLost', 'Fumbles lost'],
  ['interceptions', 'Interceptions thrown'],
  ['possessionTime', 'Possession'],
];

const SEASON_AVERAGE_STATS: readonly (readonly [string, string])[] = [
  ['totalPointsPerGame', 'Points Per Game'],
  ['yardsPerGame', 'Total Yards'],
  ['passingYardsPerGame', 'Yards Passing'],
  ['rushingYardsPerGame', 'Yards Rushing'],
  ['totalPointsPerGameAllowed', 'Points Allowed Per Game'],
  ['yardsPerGameAllowed', 'Yards Allowed'],
  ['passingYardsPerGameAllowed', 'Pass Yards Allowed'],
  ['rushingYardsPerGameAllowed', 'Rush Yards Allowed'],
];

const LEADER_CATEGORIES: readonly (readonly [LeaderCategory, string, string])[] = [
  ['passing', 'passingYards', 'Passing'],
  ['rushing', 'rushingYards', 'Rushing'],
  ['receiving', 'receivingYards', 'Receiving'],
];

const NO_STAT: StatValue = { display: null, value: null };

function statValue(stat: RawStat | undefined): StatValue {
  if (stat === undefined) return NO_STAT;
  // ESPN pads a clock (" 2:27"); otherwise the string is verbatim.
  const display = stat.displayValue?.trim() ?? '';
  return { display: display === '' ? null : display, value: stat.value };
}

function periodLabel(number: number): string {
  if (number <= 4) return String(number);
  return number === 5 ? 'OT' : `${String(number - 4)}OT`;
}

function toLineScore(raw: RawGameDetail, game: ProviderGame, kickedOff: boolean): LineScore | null {
  if (!kickedOff) return null;
  const { home, away } = raw.linescores;
  const count = Math.max(home.length, away.length);
  if (count === 0) return null;
  return {
    periods: Array.from({ length: count }, (_, index) => ({
      number: index + 1,
      label: periodLabel(index + 1),
      home: home[index] ?? null,
      away: away[index] ?? null,
    })),
    homeTotal: game.home.score,
    awayTotal: game.away.score,
  };
}

function toTeamStats(
  raw: RawGameDetail,
  game: ProviderGame,
  names: readonly (readonly [string, string])[],
): TeamStatRow[] {
  const statsOf = (teamId: string): Map<string, RawStat> =>
    new Map(
      (raw.boxscore.find((team) => team.teamId === teamId)?.stats ?? []).map((stat) => [
        stat.name,
        stat,
      ]),
    );
  const home = statsOf(game.home.team.providerTeamId);
  const away = statsOf(game.away.team.providerTeamId);
  const rows = names.map(([key, fallback]) => ({
    key,
    label: home.get(key)?.label ?? away.get(key)?.label ?? fallback,
    home: statValue(home.get(key)),
    away: statValue(away.get(key)),
  }));
  // A table of dashes says nothing that "not published" does not say better.
  return rows.some((row) => row.home.display !== null || row.away.display !== null) ? rows : [];
}

function toLeaders(raw: RawGameDetail, game: ProviderGame): LeaderRow[] {
  const leaderOf = (teamId: string, name: string): GameLeader | null => {
    const top = raw.leaders
      .find((team) => team.teamId === teamId)
      ?.categories.find((category) => category.name === name)?.top;
    if (top === undefined || top === null || top.athlete === null || top.displayValue === null) {
      return null;
    }
    return { name: top.athlete, line: top.displayValue };
  };
  const rows = LEADER_CATEGORIES.map(([category, name, label]) => ({
    category,
    label,
    home: leaderOf(game.home.team.providerTeamId, name),
    away: leaderOf(game.away.team.providerTeamId, name),
  }));
  return rows.some((row) => row.home !== null || row.away !== null) ? rows : [];
}

function toScoringPlays(raw: RawGameDetail): ScoringPlay[] {
  return raw.scoringPlays.map((play) => ({
    id: play.id,
    period: validPeriod(play.period),
    clock: play.clock,
    teamId: play.teamId,
    kind: play.abbreviation,
    text: play.text,
    homeScore: play.homeScore,
    awayScore: play.awayScore,
  }));
}

function validPeriod(period: number | null): number | null {
  return period !== null && Number.isInteger(period) && period >= 1 ? period : null;
}

/** Four decimal places: ESPN's own precision, without float noise. */
function fourDecimals(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clampProbability(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * ESPN's in-game series → the latest value and the trend. `homeWinPercentage`
 * is a 0–1 fraction in every payload seen, despite its name; a series on a
 * 0–100 scale is divided HERE, once, so nothing downstream has to know.
 */
function toWinProbability(raw: RawGameDetail): WinProbability | null {
  const points = raw.winProbability;
  const last = points.at(-1);
  if (last === undefined) return null;
  const scale = points.some((point) => point.homeWinPercentage > 1) ? 100 : 1;
  const series = points.map((point) =>
    fourDecimals(clampProbability(point.homeWinPercentage / scale)),
  );
  const home = series.at(-1) ?? 0;
  const tie =
    last.tiePercentage === null ? null : fourDecimals(clampProbability(last.tiePercentage / scale));
  return {
    source: 'espn_win_probability',
    sourceLabel: ESPN_WIN_PROBABILITY_LABEL,
    homeWinProbability: home,
    // The series publishes home and tie; away is what remains of that same
    // published figure, not a second estimate.
    awayWinProbability: fourDecimals(clampProbability(1 - home - (tie ?? 0))),
    tieProbability: tie,
    homeSeries: series,
  };
}

/**
 * A summary → what is inside the game. Before kickoff the box score is season
 * averages and the leaders are season leaders (`statsKind`); there is no line
 * score, no scoring play, no drive, and no in-game probability. A final game
 * carries no win probability at all: it is decided.
 */
export function toGameDetail(raw: RawGameDetail): GameDetail {
  const game = toProviderGame(raw.event);
  const live = inProgress(game.status, game.period);
  const kickedOff = live || game.status === 'final';
  const drive = raw.currentDrive;
  return {
    providerGameId: game.providerGameId,
    status: game.status,
    kickoffUtc: game.kickoffUtc,
    kickoffTbd: game.kickoffTbd,
    lineScore: toLineScore(raw, game, kickedOff),
    statsKind: kickedOff ? 'game' : 'season_average',
    teamStats: toTeamStats(raw, game, kickedOff ? GAME_STATS : SEASON_AVERAGE_STATS),
    leaders: toLeaders(raw, game),
    scoringPlays: kickedOff ? toScoringPlays(raw) : [],
    currentDrive:
      live && drive !== null && drive.description !== null
        ? { teamId: drive.teamId, description: drive.description }
        : null,
    winProbability: live ? toWinProbability(raw) : null,
  };
}

// ─── Slates ──────────────────────────────────────────────────────────────────

const EASTERN_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * ESPN buckets `scoreboard?dates=` by US Eastern calendar date. Confirmed in
 * the fixtures: the Friday slate includes a 10:30 PM EDT kickoff stamped
 * 02:30Z on Saturday (docs/espn-notes.md §3). So a late game belongs to the
 * slate of the Eastern day it kicked off, not the UTC day. This is the
 * deliberate date choice the plan asked to be documented.
 */
export function easternSlateKey(kickoffUtc: string): string {
  const parts = EASTERN_DATE.formatToParts(new Date(kickoffUtc));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}${part('month')}${part('day')}`;
}

// ─── Football Power Index (docs/espn-notes.md §12) ───────────────────────────

/**
 * A probability ESPN publishes as a percentage, as a probability.
 *
 * The division happens HERE, once, and never later. The domain types say 0–1
 * throughout and `scoring.ts` clamps anything outside that range, so a
 * forgotten division does not crash: it pins every team at 1.0 and fills the
 * response with `probability_out_of_range` anomalies, which is a quiet wrong
 * answer rather than a loud one. One place to divide is how that stays true.
 *
 * `null` in means the column was missing, and stays `null`: a missing
 * probability is not a zero one.
 */
function toProbability(percent: number | null): number | null {
  return percent === null ? null : percent / 100;
}

function validFpiRank(rank: number | null): number | null {
  return rank !== null && Number.isInteger(rank) && rank >= 1 ? rank : null;
}

/** Percentages summed across the payload: FPI's four nesting identities. */
function fieldSumsOf(teams: readonly RawFpiTeam[]): FpiFieldSums {
  const sum = (read: (team: RawFpiTeam) => number | null): number =>
    teams.reduce((total, team) => total + (read(team) ?? 0), 0);
  return {
    winTitle: sum((team) => team.winTitlePercent),
    makeTitleGame: sum((team) => team.makeTitleGamePercent),
    makePlayoffs: sum((team) => team.makePlayoffsPercent),
    winConference: sum((team) => team.winConferencePercent),
  };
}

/**
 * The FPI page → the national half of every team's projection inputs.
 *
 * A team whose three national probabilities are all missing is dropped rather
 * than carried as a row of nulls: the rubric's answer for "no figures at all"
 * is an absent team, which the projection reports as `unavailable`. A team that
 * has some of them is kept, and the missing ones stay `null`.
 */
export function toProjectionInputs(page: RawFpiPage): TeamProjectionsDocument {
  const teams: TeamProjectionInputs[] = [];
  for (const raw of page.teams) {
    const winTitle = toProbability(raw.winTitlePercent);
    const makeTitleGame = toProbability(raw.makeTitleGamePercent);
    const makePlayoffs = toProbability(raw.makePlayoffsPercent);
    if (winTitle === null && makeTitleGame === null && makePlayoffs === null) continue;

    teams.push({
      providerTeamId: raw.teamId,
      fpi: {
        // A single missing column among the three is a zero for that outcome's
        // arithmetic only; the terms that ARE published still stand. Treating
        // the whole team as unavailable because one field moved would throw
        // away five good numbers for one bad one (§42).
        winTitle: winTitle ?? 0,
        makeTitleGame: makeTitleGame ?? 0,
        makePlayoffs: makePlayoffs ?? 0,
        fpiRank: validFpiRank(raw.fpiRank),
        source: 'espn_fpi',
      },
      winConference: toProbability(raw.winConferencePercent),
    });
  }

  return {
    teams,
    // Verbatim. It is ESPN's statement about when it last recomputed, and the
    // screen shows it rather than our own read time (§23, §39).
    computedLabel: page.lastUpdated,
    fieldSums: fieldSumsOf(page.teams),
  };
}
