import type { Prediction, RankingsSnapshot, Season, TeamIdentity } from '@cfb/shared';
import type { ConferenceMap, ProviderGame, ProviderSchedule, SportsDataProvider } from '../types';
import { ProviderError } from '../types';
import { ESPN_CORE_API, ESPN_SITE_API, EspnClient } from './client';
import {
  easternSlateKey,
  hasInlinePrediction,
  scheduleSeasonTypes,
  toPrediction,
  toProviderGame,
  toRankings,
  toSchedule,
  toSeason,
  toTeamIdentity,
} from './normalize';
import type { RawSchedule } from './raw';
import {
  readCalendar,
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
}
