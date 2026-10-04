import type {
  GameDetail,
  Prediction,
  RankingsSnapshot,
  Season,
  SeasonWeek,
  TeamIdentity,
} from '@cfb/shared';
import { resolveSeasonFromDate } from '@cfb/shared';
import type {
  ConferenceMap,
  ConferenceOddsDocument,
  ConferenceOddsProvider,
  ProviderGame,
  ProviderSchedule,
  SportsDataProvider,
  TeamProjectionsDocument,
} from '../types';
import { ProviderError } from '../types';
import { mockGameDetail, mockSituation } from './detail';
import {
  DEFAULT_CURRENT_WEEK,
  currentWeekFor,
  generateSeason,
  hash,
  mockSeasonWeeks,
  seasonOfGameId,
} from './generate';
import { mockConferenceOdds, mockTeamProjections } from './projections';
import { ROSTER } from './roster';

export const MOCK_PREDICTOR_LABEL = 'Mock predictor (synthetic data)';
const RANKED_COUNT = 25;

/**
 * `SPORTS_PROVIDER=mock`: a full, plausible season with no network access.
 *
 * It unblocks Phase 3 (the whole UI can be built against it) and keeps local
 * development off ESPN entirely. Its data is synthetic and labelled as such:
 * freshness says `provider: 'mock'`, the poll is "Mock Top 25", and
 * predictions say `mock_predictor`. Nothing it produces claims to be ESPN's
 * (§46).
 *
 * Fixture fidelity is a different question, answered by the normalizer tests,
 * which run every captured ESPN payload through the real ESPN adapter.
 */
export class MockProvider implements SportsDataProvider {
  readonly name = 'mock' as const;
  /** The roster uses ESPN's team ids (see `roster.ts`), so its teams ARE ESPN's rows in Postgres. */
  readonly teamNamespace = 'espn' as const;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async getCurrentSeason(): Promise<Season | null> {
    const { year } = resolveSeasonFromDate(new Date(this.now()));
    return { year, type: 'regular', week: DEFAULT_CURRENT_WEEK };
  }

  async listTeams(): Promise<TeamIdentity[]> {
    return ROSTER.map((team) => ({
      provider: 'mock',
      providerTeamId: team.id,
      name: team.name,
      displayName: team.short,
      abbreviation: team.abbr,
      logoUrl: null,
      conference: team.conference,
      primaryColor: team.color,
      altColor: team.alt,
    }));
  }

  async getConferences(_season: Season): Promise<ConferenceMap> {
    return Object.fromEntries(ROSTER.map((team) => [team.id, team.conference]));
  }

  async getTeamSchedule(providerTeamId: string, season: Season): Promise<ProviderSchedule> {
    if (!ROSTER.some((team) => team.id === providerTeamId)) {
      throw new ProviderError('not_found', `mock provider has no team ${providerTeamId}`);
    }
    const games = generateSeason(season, this.now()).filter(
      (game) =>
        game.home.team.providerTeamId === providerTeamId ||
        game.away.team.providerTeamId === providerTeamId,
    );
    return { season, games, droppedEvents: 0 };
  }

  async getRankings(season: Season): Promise<RankingsSnapshot | null> {
    const ordered = [...ROSTER].sort(
      (a, b) =>
        hash(`rank:${a.id}:${String(season.year)}`) - hash(`rank:${b.id}:${String(season.year)}`),
    );
    return {
      season,
      poll: 'Mock Top 25',
      week: season.type === 'regular' ? currentWeekFor(season) : null,
      teams: ordered.slice(0, RANKED_COUNT).map((team, index) => ({
        rank: index + 1,
        providerTeamId: team.id,
        name: team.name,
        abbreviation: team.abbr,
        recordSummary: null,
      })),
    };
  }

  /** UTC calendar date. The mock has no Eastern-time bucketing to imitate. */
  slateKeyFor(kickoffUtc: string): string {
    return kickoffUtc.slice(0, 10).replaceAll('-', '');
  }

  async getSlate(slateKey: string): Promise<ProviderGame[]> {
    const season = await this.getCurrentSeason();
    if (season === null) return [];
    const now = this.now();
    // Only a slate carries down and distance, as only ESPN's scoreboard does.
    return generateSeason(season, now)
      .filter((game) => this.slateKeyFor(game.kickoffUtc) === slateKey)
      .map((game) => {
        const situation = mockSituation(game, now);
        return situation === null ? game : { ...game, situation };
      });
  }

  async getGame(providerGameId: string): Promise<ProviderGame> {
    const season = seasonOfGameId(providerGameId);
    const game =
      season === null
        ? undefined
        : generateSeason(season, this.now()).find(
            (candidate) => candidate.providerGameId === providerGameId,
          );
    if (game === undefined)
      throw new ProviderError('not_found', `mock provider has no game ${providerGameId}`);
    return game;
  }

  async getSeasonWeeks(season: Season): Promise<SeasonWeek[]> {
    return mockSeasonWeeks(season, this.now()).map(({ week, startMs, endMs }) => ({
      week,
      label: `Week ${String(week)}`,
      startUtc: new Date(startMs).toISOString(),
      endUtc: new Date(endMs).toISOString(),
    }));
  }

  /** The same timeline as every other read, so a week agrees with each team's schedule. */
  async getWeekGames(season: Season, week: number): Promise<ProviderGame[]> {
    return generateSeason(season, this.now()).filter((game) => game.week === week);
  }

  async getPrediction(providerGameId: string): Promise<Prediction | null> {
    const game = await this.getGame(providerGameId);
    const seed = hash(`predict:${providerGameId}`);
    // Roughly one game in four has no prediction, so the UI's
    // "Prediction unavailable" state is always on screen somewhere.
    if (seed % 4 === 0) return null;
    // One division, so the value is the nearest double to x.y with no float noise.
    const home = (150 + (seed % 700)) / 10;
    return {
      source: 'mock_predictor',
      sourceLabel: MOCK_PREDICTOR_LABEL,
      providerGameId,
      homeWinPct: home,
      awayWinPct: Math.round((100 - home) * 10) / 10,
      home: {
        providerTeamId: game.home.team.providerTeamId,
        name: game.home.team.name,
        abbreviation: game.home.team.abbreviation,
      },
      away: {
        providerTeamId: game.away.team.providerTeamId,
        name: game.away.team.name,
        abbreviation: game.away.team.abbreviation,
      },
      retrievedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Synthetic, labelled mock, and moving with the clock while live (Phase 3). */
  async getGameDetail(providerGameId: string): Promise<GameDetail> {
    const game = await this.getGame(providerGameId);
    return mockGameDetail(game, this.now());
  }

  /** Synthetic FPI-shaped figures, labelled `mock_projection` (§46). */
  async getTeamProjections(): Promise<TeamProjectionsDocument> {
    return mockTeamProjections();
  }
}

/**
 * `CONFERENCE_ODDS_PROVIDER=mock`: conference odds with no network and nobody's
 * site scraped.
 *
 * A separate class from `MockProvider` because the two interfaces are
 * separate, which is the point of splitting them: a drill can leave the mock
 * sports provider up and take only the odds down.
 */
export class MockConferenceOddsProvider implements ConferenceOddsProvider {
  readonly name = 'mock' as const;
  private readonly conferences: readonly string[];

  /**
   * Which conferences to publish. The caller passes the power four, so the
   * mock pays out on exactly the conferences the rubric pays for and every
   * other roster team is `not_eligible` — the state the real data produces for
   * Notre Dame and Boise State.
   */
  constructor(conferences: readonly string[]) {
    this.conferences = conferences;
  }

  async getConferenceOdds(_season: Season): Promise<ConferenceOddsDocument> {
    return mockConferenceOdds(this.conferences);
  }
}
