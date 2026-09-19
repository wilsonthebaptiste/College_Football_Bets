import type {
  GameStatus,
  Prediction,
  PredictionSide,
  RankedTeam,
  RankingsSnapshot,
  Season,
  SeasonType,
  TeamIdentity,
  TeamRecord,
  TeamRef,
} from '@cfb/shared';
import { resolveSeasonFromDate } from '@cfb/shared';
import type { ProviderCompetitor, ProviderGame, ProviderSchedule } from '../types';
import type {
  RawCalendar,
  RawCompetitor,
  RawEvent,
  RawPoll,
  RawRankings,
  RawRecordEntry,
  RawSchedule,
  RawScore,
  RawStandalonePredictor,
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
