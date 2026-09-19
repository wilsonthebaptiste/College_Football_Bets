import type { Freshness, Prediction, RankingsSnapshot, Season, TeamIdentity } from '@cfb/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SwrCache, resetInflight } from '../../src/cache/swr';
import { TieredCache, resetCacheTiers } from '../../src/cache/tiers';
import type { ProviderGame, ProviderSchedule, SportsDataProvider } from '../../src/providers/types';
import { ProviderError } from '../../src/providers/types';
import type { Services } from '../../src/services/context';
import { composeFreshness, readLiveSchedule } from '../../src/services/live';
import { buildSnapshot } from '../../src/services/snapshot';
import { testEnv } from '../helpers/supabase-stub';
import { NOW, SEASON, US, daysFromNow, game, hoursFromNow, record } from '../helpers/games';

/**
 * The live overlay (§11, §24): a 15-minute schedule, with the games that might
 * be in progress looked up in their 25-second slate.
 */

const TEAM = {
  id: '00000000-0000-4000-8000-000000000100',
  provider: 'espn' as const,
  providerTeamId: US,
  name: 'Us United',
  displayName: 'Us',
  abbreviation: 'US',
  logoUrl: null,
  conference: 'Test Conference',
  primaryColor: null,
  altColor: null,
};

const kickedOff = game({ id: 'g5', week: 5, kickoff: hoursFromNow(-1), status: 'scheduled' });
const played = game({
  week: 4,
  kickoff: daysFromNow(-7),
  status: 'final',
  us: 20,
  them: 10,
  record: record('3-1'),
});
const liveOnSlate: ProviderGame = {
  ...kickedOff,
  status: 'live',
  statusDetail: '2:10 - 2nd Quarter',
  period: 2,
  clock: '2:10',
  home: { ...kickedOff.home, score: 14 },
  away: { ...kickedOff.away, score: 7 },
};

class FakeProvider implements SportsDataProvider {
  readonly name = 'espn' as const;
  slate: ProviderGame[] | Error = [liveOnSlate];
  slateCalls = 0;

  constructor(private readonly games: ProviderGame[]) {}

  async getCurrentSeason(): Promise<Season | null> {
    return SEASON;
  }
  async listTeams(): Promise<TeamIdentity[]> {
    return [];
  }
  async getTeamSchedule(_id: string, season: Season): Promise<ProviderSchedule> {
    return { season, games: this.games, droppedEvents: 0 };
  }
  async getRankings(): Promise<RankingsSnapshot | null> {
    return null;
  }
  slateKeyFor(kickoffUtc: string): string {
    return kickoffUtc.slice(0, 10);
  }
  async getSlate(): Promise<ProviderGame[]> {
    this.slateCalls += 1;
    if (this.slate instanceof Error) throw this.slate;
    return this.slate;
  }
  async getGame(): Promise<ProviderGame> {
    throw new ProviderError('not_found', 'none');
  }
  async getPrediction(): Promise<Prediction | null> {
    return null;
  }
}

let now = NOW;

function servicesWith(provider: SportsDataProvider): Services {
  const clock = (): number => now;
  const tiers = new TieredCache({ kv: null, edge: null, now: clock, defer: null });
  return {
    env: testEnv(),
    provider,
    cache: new SwrCache({ tiers, provider: provider.name, now: clock, requestId: 'req' }),
    now: clock,
    requestId: 'req',
  };
}

beforeEach(() => {
  now = NOW;
  resetCacheTiers();
  resetInflight();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('live overlay', () => {
  it('lays the slate’s status, clock, and score over a game past kickoff', async () => {
    const provider = new FakeProvider([played, kickedOff]);
    const live = await readLiveSchedule(servicesWith(provider), US, SEASON);
    const overlaid = live.games?.find((candidate) => candidate.providerGameId === 'g5');
    expect(overlaid).toMatchObject({ status: 'live', period: 2, clock: '2:10' });
    expect(overlaid?.home.score).toBe(14);
    expect(live.liveUnverified).toBe(false);
  });

  it('puts the overlaid game in the live slot, not the previous one (§9, §11)', async () => {
    const snapshot = await buildSnapshot(
      servicesWith(new FakeProvider([played, kickedOff])),
      TEAM,
      SEASON,
    );
    expect(snapshot.envelope.data?.liveGame).toMatchObject({
      providerGameId: 'g5',
      teamScore: 14,
      result: null,
    });
    expect(snapshot.envelope.data?.previousGame?.week).toBe(4);
    // The live part's 25 s TTL governs how soon the card should be re-read.
    expect(snapshot.envelope.freshness.ttlSeconds).toBe(25);
  });

  it('does not touch the slate when nothing is near kickoff', async () => {
    const provider = new FakeProvider([played, game({ week: 5, kickoff: daysFromNow(3) })]);
    await readLiveSchedule(servicesWith(provider), US, SEASON);
    expect(provider.slateCalls).toBe(0);
  });

  it('marks the card stale when a game in its window cannot be checked (§39)', async () => {
    const provider = new FakeProvider([played, kickedOff]);
    provider.slate = new ProviderError('unavailable', 'slate down', { retryable: true });
    const snapshot = await buildSnapshot(servicesWith(provider), TEAM, SEASON);
    expect(snapshot.envelope.data?.liveGame).toBeNull();
    expect(snapshot.envelope.freshness.state).toBe('stale');
  });

  it('never lets an older slate move a game backwards', async () => {
    const services = servicesWith(new FakeProvider([played, kickedOff]));
    await readLiveSchedule(services, US, SEASON); // the slate is cached at NOW, showing the 2nd quarter

    // A minute later the OPPONENT's schedule is read for the first time. It is
    // newer than the slate and already shows the 3rd quarter. The slate refresh
    // fails, so only its older copy (still inside its stale window) remains.
    now = NOW + 60 * 1000;
    const thirdQuarter = { ...liveOnSlate, period: 3, statusDetail: '9:00 - 3rd Quarter' };
    const opponentView = new FakeProvider([thirdQuarter]);
    opponentView.slate = new ProviderError('unavailable', 'slate down', { retryable: true });
    const opponent = kickedOff.away.team.providerTeamId;

    const later = await readLiveSchedule({ ...services, provider: opponentView }, opponent, SEASON);
    expect(later.slates[0]?.status).toBe('stale');
    expect(later.games?.[0]).toMatchObject({ period: 3, statusDetail: '9:00 - 3rd Quarter' });
    expect(later.usedSlates).toHaveLength(0);
    expect(later.liveUnverified).toBe(true);
  });

  it('leaves a game alone that its (healthy) slate does not list', async () => {
    const provider = new FakeProvider([played, kickedOff]);
    provider.slate = [];
    const live = await readLiveSchedule(servicesWith(provider), US, SEASON);
    expect(live.games?.find((candidate) => candidate.providerGameId === 'g5')?.status).toBe(
      'scheduled',
    );
    expect(live.liveUnverified).toBe(false);
  });

  it('takes the updated record from the slate when a game goes final', async () => {
    const provider = new FakeProvider([played, kickedOff]);
    provider.slate = [
      {
        ...liveOnSlate,
        status: 'final',
        statusDetail: 'Final',
        period: null,
        clock: null,
        home: { ...liveOnSlate.home, score: 31, winner: true, record: record('4-1') },
        away: { ...liveOnSlate.away, score: 24, winner: false },
      },
    ];
    const snapshot = await buildSnapshot(servicesWith(provider), TEAM, SEASON);
    expect(snapshot.envelope.data?.previousGame).toMatchObject({
      providerGameId: 'g5',
      result: 'W',
      teamScore: 31,
    });
    expect(snapshot.envelope.data?.record?.summary).toBe('4-1');
  });
});

describe('composeFreshness (§39)', () => {
  const part = (state: Freshness['state'], fetchedAt: string | null): Freshness => ({
    state,
    fetchedAt,
    ttlSeconds: 900,
    expiresAt: fetchedAt,
    source: state === 'fresh' ? 'provider' : 'cache',
    provider: 'espn',
  });
  const compose = (primary: Freshness[], reference: Freshness[], forceStale = false) =>
    composeFreshness({ provider: 'espn', primary, reference, forceStale });

  it('stays fresh when only a reference part (rankings) came from cache', () => {
    const composed = compose([part('fresh', '2026-09-19T01:00:00Z')], [part('cached', null)]);
    expect(composed).toMatchObject({
      state: 'fresh',
      source: 'provider',
      fetchedAt: '2026-09-19T01:00:00Z',
    });
  });

  it('goes stale when a reference part is stale, without taking its timestamp', () => {
    const composed = compose(
      [part('fresh', '2026-09-19T01:00:00Z')],
      [part('stale', '2026-09-18T01:00:00Z')],
    );
    expect(composed).toMatchObject({ state: 'stale', fetchedAt: '2026-09-19T01:00:00Z' });
  });

  it('takes the worst primary state and the oldest primary timestamp', () => {
    const composed = compose(
      [part('fresh', '2026-09-19T01:00:00Z'), part('cached', '2026-09-19T00:50:00Z')],
      [],
    );
    expect(composed).toMatchObject({
      state: 'cached',
      source: 'cache',
      fetchedAt: '2026-09-19T00:50:00Z',
    });
    expect(compose([part('fresh', '2026-09-19T01:00:00Z')], [], true).state).toBe('stale');
  });
});
