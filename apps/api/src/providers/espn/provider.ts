import type { Prediction, RankingsSnapshot, Season, TeamIdentity } from '@cfb/shared';
import type {
  ConferenceMap,
  FpiFieldSums,
  ProviderGame,
  ProviderSchedule,
  SportsDataProvider,
  TeamProjectionsDocument,
} from '../types';
import { ProviderError } from '../types';
import { ESPN_CORE_API, ESPN_FITT_API, ESPN_SITE_API, EspnClient } from './client';
import {
  easternSlateKey,
  hasInlinePrediction,
  scheduleSeasonTypes,
  toPrediction,
  toProjectionInputs,
  toProviderGame,
  toRankings,
  toSchedule,
  toSeason,
  toTeamIdentity,
} from './normalize';
import type { RawSchedule } from './raw';
import {
  readCalendar,
  readFpiPage,
  readGroup,
  readRankings,
  readRefPage,
  readSchedule,
  readScoreboard,
  readStandalonePredictor,
  readSummary,
  readTeamList,
} from './validate';

/** Ids are interpolated into ESPN URLs; anything unusual cannot be a real id. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const SLATE_KEY = /^\d{8}$/;

/** ESPN's group id for FBS, the parent of every FBS conference (espn-notes §7). */
const FBS_GROUP = '80';
/**
 * Conferences fetched at once. Each costs two requests, and ESPN's CDN answers
 * bursts with a 403 (espn-notes §1), so this stays small.
 */
const CONFERENCE_BATCH = 3;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

function safeId(value: string): string {
  if (!SAFE_ID.test(value)) {
    throw new ProviderError('not_found', 'Not a valid provider id');
  }
  return encodeURIComponent(value);
}

function invalid(what: string): ProviderError {
  return new ProviderError('invalid_response', `ESPN ${what} payload failed validation`);
}

/**
 * FPI covers 138 teams on one page. 200 leaves room for a conference
 * realignment without a second request, and `pagination.pages` is checked so a
 * silently truncated read can never be mistaken for a complete one.
 */
const FPI_LIMIT = 200;

/**
 * FPI's four nesting identities, and how far each may drift before it is worth
 * saying so: one champion, two finalists, twelve playoff places, ten FBS
 * conference titles, each a sum of percentages across every rated team.
 *
 * The tolerances are about 1% of each expected value. Measured sums have sat
 * within a point of all four on every capture, and a dropped page or a
 * misaligned column misses by far more than this.
 */
const FPI_IDENTITIES: readonly {
  field: keyof FpiFieldSums;
  expected: number;
  tolerance: number;
}[] = [
  { field: 'winTitle', expected: 100, tolerance: 2 },
  { field: 'makeTitleGame', expected: 200, tolerance: 3 },
  { field: 'makePlayoffs', expected: 1200, tolerance: 12 },
  { field: 'winConference', expected: 1000, tolerance: 10 },
];

/**
 * Reports a field sum that has drifted out of tolerance, and keeps going.
 *
 * A warning rather than a throw, deliberately: a slightly-off sum is a
 * publisher's rounding, and taking the whole feature down over it would turn a
 * cosmetic drift into an outage. A sum that is wildly off will have broken the
 * two-way join and the per-team figures as well, which is where it is caught.
 */
function warnOnFieldSums(sums: FpiFieldSums, teams: number): void {
  const broken = FPI_IDENTITIES.filter(
    ({ field, expected, tolerance }) => Math.abs(sums[field] - expected) > tolerance,
  );
  if (broken.length === 0) return;
  console.warn(
    JSON.stringify({
      level: 'warn',
      provider: 'espn',
      event: 'fpi_field_sum_out_of_tolerance',
      teams,
      fields: broken.map(({ field, expected, tolerance }) => ({
        field,
        expected,
        tolerance,
        measured: sums[field],
      })),
    }),
  );
}

/**
 * `SportsDataProvider` over ESPN's public JSON. Every URL, field name, and
 * status string in the application lives in this directory (§5, §26).
 */
export class EspnProvider implements SportsDataProvider {
  readonly name = 'espn' as const;
  readonly teamNamespace = 'espn' as const;
  private readonly client: EspnClient;
  private readonly now: () => number;

  constructor(client: EspnClient = new EspnClient(), now: () => number = Date.now) {
    this.client = client;
    this.now = now;
  }

  async getCurrentSeason(): Promise<Season | null> {
    const { body } = await this.client.getJson(`${ESPN_SITE_API}/scoreboard`);
    const raw = readCalendar(body);
    if (raw === null) throw invalid('calendar');
    return toSeason(raw);
  }

  async listTeams(): Promise<TeamIdentity[]> {
    // 762 teams across every division (espn-notes §1); `limit=400` would truncate.
    const { body } = await this.client.getJson(`${ESPN_SITE_API}/teams?limit=900`);
    const raw = readTeamList(body);
    if (raw === null) throw invalid('team list');
    return raw.map(toTeamIdentity);
  }

  /**
   * FBS conference names, which no team payload carries (espn-notes §7). The
   * core API lists FBS's conferences, and each conference its name and its
   * teams: 1 + 2 × 11 small requests, cached for a day above this layer.
   *
   * All or nothing. A conference that fails to load throws, rather than
   * leaving its teams silently conference-less for a day.
   */
  async getConferences(season: Season): Promise<ConferenceMap> {
    const base = `${ESPN_CORE_API}/seasons/${String(season.year)}/types/2/groups`;
    const children = readRefPage(
      (await this.client.getJson(`${base}/${FBS_GROUP}/children?limit=100`)).body,
      'groups',
    );
    if (children === null || children.ids.length === 0) throw invalid('conference list');

    const map: ConferenceMap = {};
    for (const batch of chunks(children.ids, CONFERENCE_BATCH)) {
      await Promise.all(
        batch.map(async (groupId) => {
          const id = safeId(groupId);
          const [detail, members] = await Promise.all([
            this.client.getJson(`${base}/${id}`),
            this.client.getJson(`${base}/${id}/teams?limit=200`),
          ]);
          const group = readGroup(detail.body);
          const teams = readRefPage(members.body, 'teams');
          const label = group?.shortName ?? group?.name ?? null;
          if (label === null || teams === null) throw invalid(`conference ${groupId}`);
          if (teams.count !== null && teams.count > teams.ids.length) {
            throw invalid(`conference ${groupId} (a truncated team page)`);
          }
          for (const teamId of teams.ids) map[teamId] = label;
        }),
      );
    }
    return map;
  }

  async getTeamSchedule(providerTeamId: string, season: Season): Promise<ProviderSchedule> {
    const id = safeId(providerTeamId);
    const payloads = await Promise.all(
      scheduleSeasonTypes(season).map(async (seasonType): Promise<RawSchedule> => {
        const url = `${ESPN_SITE_API}/teams/${id}/schedule?season=${String(season.year)}&seasontype=${String(seasonType)}`;
        const { body } = await this.client.getJson(url);
        const raw = readSchedule(body);
        if (raw === null) throw invalid('schedule');
        // The root `season` is always ESPN's CURRENT season, whatever was asked.
        // `requestedSeason` is the one that says what these events belong to.
        if (raw.requestedSeasonYear !== null && raw.requestedSeasonYear !== season.year) {
          throw invalid(
            `schedule (asked for ${String(season.year)}, got ${String(raw.requestedSeasonYear)})`,
          );
        }
        return raw;
      }),
    );
    return toSchedule(payloads, season);
  }

  async getRankings(season: Season): Promise<RankingsSnapshot | null> {
    const { body } = await this.client.getJson(`${ESPN_SITE_API}/rankings`);
    const raw = readRankings(body);
    if (raw === null) throw invalid('rankings');
    return toRankings(raw, season);
  }

  slateKeyFor(kickoffUtc: string): string {
    return easternSlateKey(kickoffUtc);
  }

  async getSlate(slateKey: string): Promise<ProviderGame[]> {
    if (!SLATE_KEY.test(slateKey)) throw new ProviderError('not_found', 'Not a valid slate key');
    // groups=80 is FBS: every game with at least one FBS team (espn-notes §1).
    const url = `${ESPN_SITE_API}/scoreboard?dates=${slateKey}&groups=80&limit=300`;
    const { body } = await this.client.getJson(url);
    const raw = readScoreboard(body);
    if (raw === null) throw invalid('scoreboard');
    return raw.events.map((event) => toProviderGame(event));
  }

  async getGame(providerGameId: string): Promise<ProviderGame> {
    const id = safeId(providerGameId);
    const { body } = await this.client.getJson(`${ESPN_SITE_API}/summary?event=${id}`);
    const raw = readSummary(body);
    if (raw === null) throw invalid('summary');
    return toProviderGame(raw.event);
  }

  async getPrediction(providerGameId: string): Promise<Prediction | null> {
    const id = safeId(providerGameId);
    const { body } = await this.client.getJson(`${ESPN_SITE_API}/summary?event=${id}`);
    const summary = readSummary(body);
    if (summary === null) throw invalid('summary');

    const retrievedAt = new Date(this.now()).toISOString();
    if (hasInlinePrediction(summary)) return toPrediction(summary, null, retrievedAt);

    // No inline predictor. Ask the core API directly: it answers 404 with a
    // JSON body when ESPN has no prediction for this game (espn-notes §6).
    const standalone = await this.client.getJson(
      `${ESPN_CORE_API}/events/${id}/competitions/${id}/predictor`,
      { notFoundIsData: true },
    );
    if (standalone.status === 404) return null;
    return toPrediction(summary, readStandalonePredictor(standalone.body), retrievedAt);
  }

  /**
   * The Football Power Index table: one request for every team ESPN rates
   * (docs/espn-notes.md §12). The national half of projected points.
   *
   * It is not season-scoped. The endpoint answers for whatever season ESPN is
   * currently rating, and says so in `lastUpdated`; asking it for a past season
   * is not something it supports.
   */
  async getTeamProjections(): Promise<TeamProjectionsDocument> {
    const url = `${ESPN_FITT_API}/powerindex?region=us&lang=en&contentorigin=espn&limit=${String(FPI_LIMIT)}`;
    const { body } = await this.client.getJson(url);
    const raw = readFpiPage(body);
    if (raw === null) throw invalid('power index');

    // A second page means the limit no longer covers the league, and a partial
    // table would quietly give every missing team no projection at all.
    if (raw.pages !== null && raw.pages > 1) {
      throw invalid(`power index (${String(raw.pages)} pages; limit ${String(FPI_LIMIT)})`);
    }
    if (raw.teams.length === 0) throw invalid('power index (no teams)');

    const document = toProjectionInputs(raw);
    warnOnFieldSums(document.fieldSums, document.teams.length);
    return document;
  }
}
