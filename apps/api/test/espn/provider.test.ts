import type { Season } from '@cfb/shared';
import { describe, expect, it } from 'vitest';
import { EspnClient } from '../../src/providers/espn/client';
import { EspnProvider } from '../../src/providers/espn/provider';
import { ProviderError } from '../../src/providers/types';
import { espnStub, type EspnStubOptions } from '../helpers/espn-stub';
import { fixture } from '../helpers/fixtures';

const REGULAR: Season = { year: 2026, type: 'regular', week: 3 };

function provider(options: EspnStubOptions = {}) {
  const stub = espnStub(options);
  const client = new EspnClient({ fetch: stub.fetch, sleep: async () => undefined });
  return {
    espn: new EspnProvider(client, () => Date.parse('2026-09-18T12:00:00Z')),
    urls: stub.urls,
  };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('expected a ProviderError');
}

describe('EspnProvider', () => {
  it('reads the season from the bare scoreboard', async () => {
    const { espn } = provider();
    await expect(espn.getCurrentSeason()).resolves.toEqual({
      year: 2026,
      type: 'regular',
      week: 3,
    });
  });

  it('asks for the season it wants, by year and type (§21)', async () => {
    const { espn, urls } = provider();
    const schedule = await espn.getTeamSchedule('251', REGULAR);
    expect(schedule.games).toHaveLength(12);
    expect(urls).toEqual([
      'https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/251/schedule?season=2026&seasontype=2',
    ]);
  });

  it('adds the bowl schedule in the postseason', async () => {
    const { espn, urls } = provider();
    await espn.getTeamSchedule('251', { year: 2026, type: 'postseason', week: null });
    expect(urls.map((url) => new URL(url).searchParams.get('seasontype'))).toEqual(['2', '3']);
  });

  it('refuses a schedule for a season it did not ask for', async () => {
    const body = fixture('schedule-ranked') as { requestedSeason: { year: number } };
    body.requestedSeason.year = 2019;
    const { espn } = provider({
      override: (url) => (url.pathname.endsWith('/schedule') ? Response.json(body) : null),
    });
    expect(await failure(espn.getTeamSchedule('251', REGULAR))).toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('fails a garbage payload as invalid_response, never a crash (§40)', async () => {
    const { espn } = provider({
      override: (url) =>
        url.pathname.endsWith('/rankings') ? Response.json({ unexpected: true }) : null,
    });
    expect(await failure(espn.getRankings(REGULAR))).toMatchObject({ kind: 'invalid_response' });
  });

  it('fetches a slate by Eastern date, FBS only', async () => {
    const { espn, urls } = provider();
    const key = espn.slateKeyFor('2026-09-19T00:00:00.000Z');
    expect(key).toBe('20260918');
    const games = await espn.getSlate(key);
    expect(games.some((game) => game.status === 'live')).toBe(true);
    expect(new URL(urls[0]!).searchParams.get('groups')).toBe('80');
  });

  it('uses the inline predictor when the summary has one: no second request', async () => {
    const { espn, urls } = provider();
    await expect(espn.getPrediction('401858226')).resolves.toMatchObject({
      homeWinPct: 8.3,
      awayWinPct: 91.7,
    });
    expect(urls).toHaveLength(1);
  });

  it('asks the core API when the summary has no predictor', async () => {
    const { espn, urls } = provider();
    await expect(espn.getPrediction('401858225')).resolves.toMatchObject({
      homeWinPct: 82.5,
      awayWinPct: 17.5,
    });
    expect(urls[1]).toContain('sports.core.api.espn.com');
  });

  it('answers null, not an error, when ESPN has no prediction (§12)', async () => {
    const { espn } = provider({ predictors: [] });
    await expect(espn.getPrediction('401858225')).resolves.toBeNull();
  });

  it('reports an unknown game as not_found', async () => {
    const { espn } = provider();
    expect(await failure(espn.getGame('123'))).toMatchObject({ kind: 'not_found' });
  });

  it('never builds a URL from an id with unusual characters', async () => {
    const { espn, urls } = provider();
    expect(await failure(espn.getGame('../teams?limit=900'))).toMatchObject({ kind: 'not_found' });
    expect(urls).toHaveLength(0);
  });
});

describe('EspnProvider.getConferences (espn-notes §7, plan §5.1)', () => {
  it('maps every team in each FBS conference to the conference short name', async () => {
    const { espn, urls } = provider();
    const map = await espn.getConferences(REGULAR);

    // The SEC capture lists 16 teams; the other ten groups are served empty.
    expect(Object.values(map).filter((name) => name === 'SEC')).toHaveLength(16);
    expect(map['333']).toBe('SEC'); // Alabama
    expect(map['61']).toBe('SEC'); // Georgia
    expect(map['194']).toBeUndefined(); // Ohio State is Big Ten, served empty here

    // One index read, then a name and a member list per conference.
    expect(urls[0]).toContain('/seasons/2026/types/2/groups/80/children');
    expect(urls).toHaveLength(1 + 2 * 11);
  });

  it('is all or nothing: one conference failing fails the map', async () => {
    const { espn } = provider({
      override: (url) =>
        url.pathname.endsWith('/groups/5/teams') ? new Response('nope', { status: 500 }) : null,
    });
    expect(await failure(espn.getConferences(REGULAR))).toMatchObject({ kind: 'unavailable' });
  });

  it('refuses a truncated member page rather than map part of a conference', async () => {
    const { espn } = provider({
      override: (url) =>
        url.pathname.endsWith('/groups/8/teams')
          ? Response.json({
              count: 40,
              items: [{ $ref: 'http://x/v2/seasons/2026/teams/333?lang=en' }],
            })
          : null,
    });
    expect(await failure(espn.getConferences(REGULAR))).toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('reads ids only from well-formed refs, so a hostile ref cannot reach a URL', async () => {
    const { espn, urls } = provider({
      override: (url) =>
        url.pathname.endsWith('/groups/80/children')
          ? Response.json({
              count: 2,
              items: [
                { $ref: 'http://x/v2/seasons/2026/types/2/groups/8?lang=en' },
                { $ref: 'http://x/v2/seasons/2026/types/2/groups/..%2F..%2Fevil' },
              ],
            })
          : null,
    });
    const map = await espn.getConferences(REGULAR);
    expect(map['333']).toBe('SEC');
    expect(urls.some((url) => url.includes('evil'))).toBe(false);
  });
});
