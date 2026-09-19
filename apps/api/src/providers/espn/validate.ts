import type {
  RawCalendar,
  RawCompetitor,
  RawEvent,
  RawInlinePredictor,
  RawLogo,
  RawPoll,
  RawRank,
  RawRankings,
  RawRecordEntry,
  RawSchedule,
  RawScoreboard,
  RawScore,
  RawStandalonePredictor,
  RawStatus,
  RawSummary,
  RawTeam,
} from './raw';

/**
 * Untrusted-input guards for every ESPN field this application reads (§40).
 *
 * ESPN's JSON is undocumented and unversioned, so it is handled as hostile
 * input. Every function here is TOTAL: whatever it is given (garbage, a
 * truncated payload, `null`, a string where an object should be), it returns
 * either a narrowed value or `null`. It never throws. The property test in
 * test/espn/validate.test.ts holds it to that by deleting random fields from
 * every fixture.
 *
 * A payload-level `null` becomes a `ProviderError('invalid_response')`, and
 * the cache turns that into a `stale` or `unavailable` envelope. A shape change
 * at ESPN therefore degrades a section; it never crashes a render.
 */

// ─── Primitive readers ───────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function path(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) current = field(current, key);
  return current;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A number ESPN sometimes sends as a string, e.g. a projection of `"91.7"`. */
function numeric(value: unknown): number | null {
  const direct = finite(value);
  if (direct !== null) return direct;
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

/**
 * Identifiers end up in URLs we build, so they are held to a boring shape.
 * ESPN ids are digit strings, but occasionally arrive as numbers.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/;

function identifier(value: unknown): string | null {
  if (typeof value === 'string' && SAFE_ID.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function parsesAsDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

// ─── Teams ───────────────────────────────────────────────────────────────────

function readLogo(value: unknown): RawLogo[] {
  const href = text(field(value, 'href'));
  if (href === null) return [];
  const rel = list(field(value, 'rel')).filter(
    (entry): entry is string => typeof entry === 'string',
  );
  return [{ href, rel }];
}

export function readTeam(value: unknown): RawTeam | null {
  const id = identifier(field(value, 'id'));
  if (id === null) return null;
  return {
    id,
    displayName: text(field(value, 'displayName')),
    shortDisplayName: text(field(value, 'shortDisplayName')),
    name: text(field(value, 'name')),
    location: text(field(value, 'location')),
    abbreviation: text(field(value, 'abbreviation')),
    color: text(field(value, 'color')),
    alternateColor: text(field(value, 'alternateColor')),
    logos: list(field(value, 'logos')).flatMap(readLogo),
    logo: text(field(value, 'logo')),
  };
}

/** `teams?limit=900` → `sports[0].leagues[0].teams[].team`. Bad entries are skipped. */
export function readTeamList(body: unknown): RawTeam[] | null {
  const teams = path(list(field(list(field(body, 'sports'))[0], 'leagues'))[0], ['teams']);
  if (!Array.isArray(teams)) return null;
  const valid: RawTeam[] = [];
  for (const entry of teams) {
    const team = readTeam(field(entry, 'team'));
    if (team !== null) valid.push(team);
  }
  return valid;
}

// ─── Games ───────────────────────────────────────────────────────────────────

function readScore(value: unknown): RawScore | null {
  if (typeof value === 'string') return { shape: 'string', text: value };
  if (typeof value === 'number')
    return { shape: 'object', value: finite(value), displayValue: null };
  if (isObject(value)) {
    return {
      shape: 'object',
      value: finite(value['value']),
      displayValue: text(value['displayValue']),
    };
  }
  return null;
}

/** Schedule and summary say `record[]`; the scoreboard says `records[]`. */
function readRecordEntries(competitor: unknown): RawRecordEntry[] {
  const entries = [...list(field(competitor, 'record')), ...list(field(competitor, 'records'))];
  const valid: RawRecordEntry[] = [];
  for (const entry of entries) {
    const type = text(field(entry, 'type'));
    if (type === null) continue;
    valid.push({
      type,
      summary: text(field(entry, 'summary')) ?? text(field(entry, 'displayValue')),
    });
  }
  return valid;
}

function readCompetitor(value: unknown): RawCompetitor | null {
  const homeAway = field(value, 'homeAway');
  if (homeAway !== 'home' && homeAway !== 'away') return null;
  const team = readTeam(field(value, 'team'));
  if (team === null) return null;
  return {
    homeAway,
    team,
    score: readScore(field(value, 'score')),
    winner: flag(field(value, 'winner')),
    curatedRank: finite(path(value, ['curatedRank', 'current'])),
    records: readRecordEntries(value),
  };
}

function readStatus(value: unknown): RawStatus | null {
  if (!isObject(value)) return null;
  const type = value['type'];
  return {
    name: text(field(type, 'name')),
    state: text(field(type, 'state')),
    completed: flag(field(type, 'completed')),
    detail: text(field(type, 'detail')),
    shortDetail: text(field(type, 'shortDetail')),
    period: finite(value['period']),
    displayClock: text(value['displayClock']),
  };
}

/** Schedule and summary: `broadcasts[].media.shortName`. Scoreboard: `broadcasts[].names[]`. */
function readBroadcast(competition: unknown): string | null {
  for (const broadcast of list(field(competition, 'broadcasts'))) {
    const media = text(path(broadcast, ['media', 'shortName']));
    if (media !== null) return media;
    const named = list(field(broadcast, 'names'))
      .map(text)
      .find((name) => name !== null);
    if (named !== undefined && named !== null) return named;
  }
  return null;
}

interface EventParts {
  id: unknown;
  date: unknown;
  timeValid: unknown;
  seasonYear: unknown;
  seasonType: unknown;
  week: unknown;
  venue: unknown;
  competition: unknown;
}

/**
 * The three payload families put the same facts in different places. Each
 * caller below says where; this assembles and checks them.
 *
 * Required: an id, a parseable date, and exactly one home and one away
 * competitor. A game without those cannot be shown truthfully, so it is
 * rejected whole rather than rendered with guessed parts.
 */
function readEvent(parts: EventParts): RawEvent | null {
  const id = identifier(parts.id);
  const date = text(parts.date);
  if (id === null || date === null || !parsesAsDate(date)) return null;

  const competitors = list(field(parts.competition, 'competitors'));
  if (competitors.length !== 2) return null;
  const [first, second] = competitors.map(readCompetitor);
  if (first === null || first === undefined || second === null || second === undefined) {
    return null;
  }
  const home = first.homeAway === 'home' ? first : second;
  const away = first.homeAway === 'away' ? first : second;
  if (home.homeAway !== 'home' || away.homeAway !== 'away') return null;

  return {
    id,
    date,
    timeValid: flag(parts.timeValid),
    seasonYear: finite(parts.seasonYear),
    seasonType: finite(parts.seasonType),
    week: finite(parts.week),
    neutralSite: flag(field(parts.competition, 'neutralSite')),
    venue: text(parts.venue),
    broadcast: readBroadcast(parts.competition),
    status: readStatus(field(parts.competition, 'status')),
    home,
    away,
  };
}

/** `events[]` in a schedule or a scoreboard. */
function readSiteEvent(event: unknown): RawEvent | null {
  const competition = list(field(event, 'competitions'))[0];
  return readEvent({
    id: field(event, 'id'),
    date: field(event, 'date') ?? field(competition, 'date'),
    timeValid: field(event, 'timeValid') ?? field(competition, 'timeValid'),
    seasonYear: path(event, ['season', 'year']),
    // Schedule: `seasonType.type`. Scoreboard: `season.type`.
    seasonType: path(event, ['seasonType', 'type']) ?? path(event, ['season', 'type']),
    week: path(event, ['week', 'number']),
    venue: path(competition, ['venue', 'fullName']),
    competition,
  });
}

function readEvents(body: unknown): { events: RawEvent[]; droppedEvents: number } | null {
  const events = field(body, 'events');
  if (!Array.isArray(events)) return null;
  const valid: RawEvent[] = [];
  let droppedEvents = 0;
  for (const event of events) {
    const parsed = readSiteEvent(event);
    if (parsed === null) droppedEvents += 1;
    else valid.push(parsed);
  }
  return { events: valid, droppedEvents };
}

/** `teams/{id}/schedule?season=…&seasontype=…` */
export function readSchedule(body: unknown): RawSchedule | null {
  const read = readEvents(body);
  if (read === null) return null;
  return {
    requestedSeasonYear: finite(path(body, ['requestedSeason', 'year'])),
    requestedSeasonType: finite(path(body, ['requestedSeason', 'type'])),
    ...read,
  };
}

/** `scoreboard?dates=YYYYMMDD&groups=80` */
export function readScoreboard(body: unknown): RawScoreboard | null {
  return readEvents(body);
}

/** Bare `scoreboard`: root `season` and `week` (espn-notes §8). */
export function readCalendar(body: unknown): RawCalendar | null {
  const seasonYear = finite(path(body, ['season', 'year']));
  const seasonType = finite(path(body, ['season', 'type']));
  if (seasonYear === null || seasonType === null) return null;
  return { seasonYear, seasonType, week: finite(path(body, ['week', 'number'])) };
}

// ─── Summary and predictions ─────────────────────────────────────────────────

function readInlinePredictor(value: unknown): RawInlinePredictor | null {
  if (!isObject(value)) return null;
  return {
    homeTeamId: identifier(path(value, ['homeTeam', 'id'])),
    homeProjection: numeric(path(value, ['homeTeam', 'gameProjection'])),
    awayTeamId: identifier(path(value, ['awayTeam', 'id'])),
    awayProjection: numeric(path(value, ['awayTeam', 'gameProjection'])),
  };
}

/** `summary?event={id}` → `header` plus the inline `predictor`. */
export function readSummary(body: unknown): RawSummary | null {
  const header = field(body, 'header');
  const competition = list(field(header, 'competitions'))[0];
  const event = readEvent({
    id: field(header, 'id'),
    date: field(competition, 'date'),
    timeValid: field(header, 'timeValid') ?? field(competition, 'timeValid'),
    seasonYear: path(header, ['season', 'year']),
    seasonType: path(header, ['season', 'type']),
    // A bare number here, unlike the `{ number }` object everywhere else.
    week: field(header, 'week'),
    venue:
      path(body, ['gameInfo', 'venue', 'fullName']) ?? path(competition, ['venue', 'fullName']),
    competition,
  });
  if (event === null) return null;
  return { event, predictor: readInlinePredictor(field(body, 'predictor')) };
}

/** `statistics[name="gameProjection"].value`. Selected by name: order is not a contract. */
function readProjection(side: unknown): number | null {
  const stat = list(field(side, 'statistics')).find(
    (entry) => field(entry, 'name') === 'gameProjection',
  );
  return numeric(field(stat, 'value'));
}

/** Core API predictor. A body without both sides is not a predictor. */
export function readStandalonePredictor(body: unknown): RawStandalonePredictor | null {
  const home = field(body, 'homeTeam');
  const away = field(body, 'awayTeam');
  if (!isObject(home) || !isObject(away)) return null;
  return { homeProjection: readProjection(home), awayProjection: readProjection(away) };
}

/**
 * ESPN sometimes answers HTTP 200 with an error document (plan, Phase 2
 * "watch out for"), and the core API's 404 carries one too:
 * `{ "error": { "message": "No event found…", "code": 404 } }`.
 */
export function readErrorBody(body: unknown): { code: number | null } | null {
  const nested = field(body, 'error');
  if (isObject(nested)) return { code: finite(nested['code']) };
  // The flat variant: `{ "code": 400, "message": "…" }` with no data keys.
  if (isObject(body) && finite(body['code']) !== null && text(body['message']) !== null) {
    return { code: finite(body['code']) };
  }
  return null;
}

// ─── Rankings ────────────────────────────────────────────────────────────────

function readRank(value: unknown): RawRank | null {
  const current = finite(field(value, 'current'));
  const team = readTeam(field(value, 'team'));
  if (current === null || !Number.isInteger(current) || current < 1 || team === null) return null;
  return { current, team, recordSummary: text(field(value, 'recordSummary')) };
}

function readPoll(value: unknown): RawPoll | null {
  if (!isObject(value)) return null;
  const rawRanks = value['ranks'];
  let ranks: RawRank[] | null = null;
  if (Array.isArray(rawRanks)) {
    const parsed = rawRanks.map(readRank);
    // All or nothing. Silently dropping one bad entry would report that team
    // as unranked, asserting something we do not know (§7).
    ranks = parsed.every((rank): rank is RawRank => rank !== null) ? parsed : null;
  }
  return {
    type: text(value['type']),
    name: text(value['name']),
    shortName: text(value['shortName']),
    week: finite(path(value, ['occurrence', 'number'])),
    seasonYear: finite(path(value, ['season', 'year'])),
    ranks,
  };
}

export function readRankings(body: unknown): RawRankings | null {
  const polls = field(body, 'rankings');
  if (!Array.isArray(polls)) return null;
  return { polls: polls.map(readPoll).filter((poll): poll is RawPoll => poll !== null) };
}
