import type { Prediction, RankingsSnapshot, Season, TeamIdentity } from '@cfb/shared';
import type { ConferenceMap, ProviderGame, ProviderSchedule, SportsDataProvider } from './types';
import { ProviderError } from './types';

/**
 * Fault injection: `SPORTS_PROVIDER_FAULT` makes chosen provider calls throw,
 * so the degraded paths can be exercised on purpose instead of waiting for
 * ESPN to break (plan Phase 2 exit criteria: "killing the provider", "forcing
 * one team to fail"). It wraps any provider, mock or ESPN.
 *
 * Comma-separated tokens:
 *   all          every call fails ("the provider is down")
 *   team:<id>    that team's schedule fails, and nothing else (§42 isolation)
 *   schedule     every schedule fails
 *   rankings | slate | game | prediction | calendar | teams | conferences
 *
 * The failure is a retryable `unavailable`, the same as a real ESPN outage.
 */

type Operation =
  'schedule' | 'rankings' | 'slate' | 'game' | 'prediction' | 'calendar' | 'teams' | 'conferences';

const OPERATIONS: readonly Operation[] = [
  'schedule',
  'rankings',
  'slate',
  'game',
  'prediction',
  'calendar',
  'teams',
  'conferences',
];

export interface FaultPlan {
  all: boolean;
  operations: ReadonlySet<Operation>;
  teams: ReadonlySet<string>;
}

export function parseFaults(raw: string | undefined): FaultPlan | null {
  if (raw === undefined || raw.trim() === '') return null;
  const operations = new Set<Operation>();
  const teams = new Set<string>();
  let all = false;
  for (const token of raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')) {
    if (token === 'all') all = true;
    else if (token.startsWith('team:')) teams.add(token.slice('team:'.length));
    else if ((OPERATIONS as readonly string[]).includes(token)) operations.add(token as Operation);
  }
  if (!all && operations.size === 0 && teams.size === 0) return null;
  return { all, operations, teams };
}

function injected(operation: string): ProviderError {
  return new ProviderError('unavailable', `injected fault (SPORTS_PROVIDER_FAULT): ${operation}`, {
    retryable: true,
  });
}

export class FaultyProvider implements SportsDataProvider {
  readonly name: SportsDataProvider['name'];
  readonly teamNamespace: SportsDataProvider['teamNamespace'];
  private readonly inner: SportsDataProvider;
  private readonly plan: FaultPlan;

  constructor(inner: SportsDataProvider, plan: FaultPlan) {
    this.inner = inner;
    this.plan = plan;
    this.name = inner.name;
    this.teamNamespace = inner.teamNamespace;
  }

  private check(operation: Operation, teamId?: string): void {
    if (this.plan.all || this.plan.operations.has(operation)) throw injected(operation);
    if (teamId !== undefined && this.plan.teams.has(teamId))
      throw injected(`${operation} for team ${teamId}`);
  }

  async getCurrentSeason(): Promise<Season | null> {
    this.check('calendar');
    return this.inner.getCurrentSeason();
  }

  async listTeams(): Promise<TeamIdentity[]> {
    this.check('teams');
    return this.inner.listTeams();
  }

  async getConferences(season: Season): Promise<ConferenceMap> {
    this.check('conferences');
    return this.inner.getConferences(season);
  }

  async getTeamSchedule(providerTeamId: string, season: Season): Promise<ProviderSchedule> {
    this.check('schedule', providerTeamId);
    return this.inner.getTeamSchedule(providerTeamId, season);
  }

  async getRankings(season: Season): Promise<RankingsSnapshot | null> {
    this.check('rankings');
    return this.inner.getRankings(season);
  }

  slateKeyFor(kickoffUtc: string): string {
    return this.inner.slateKeyFor(kickoffUtc);
  }

  async getSlate(slateKey: string): Promise<ProviderGame[]> {
    this.check('slate');
    return this.inner.getSlate(slateKey);
  }

  async getGame(providerGameId: string): Promise<ProviderGame> {
    this.check('game');
    return this.inner.getGame(providerGameId);
  }

  async getPrediction(providerGameId: string): Promise<Prediction | null> {
    this.check('prediction');
    return this.inner.getPrediction(providerGameId);
  }
}
