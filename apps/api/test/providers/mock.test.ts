import type { Season } from '@cfb/shared';
import { describe, expect, it } from 'vitest';
import { decodeGameId, encodeGameId, generateSeason } from '../../src/providers/mock/generate';
import { MockProvider } from '../../src/providers/mock/provider';
import { ROSTER } from '../../src/providers/mock/roster';
import { deriveSlots } from '../../src/services/derive';

/**
 * The mock provider exists so Phase 3 can build every UI state offline. These
 * tests hold it to that: all fifty seeded teams, schedules that agree with each
 * other, and every state the board must render present somewhere.
 */

const NOW = Date.parse('2026-10-07T18:00:00Z'); // a Wednesday afternoon
const REGULAR: Season = { year: 2026, type: 'regular', week: 6 };

describe('mock season generation', () => {
  const games = generateSeason(REGULAR, NOW);

  it('is deterministic for a given season and clock', () => {
    expect(generateSeason(REGULAR, NOW)).toEqual(games);
  });

  it('gives every seeded team a schedule', () => {
    for (const team of ROSTER) {
      const own = games.filter((game) =>
        [game.home, game.away].some((side) => side.team.providerTeamId === team.id),
      );
      expect(own.length).toBeGreaterThanOrEqual(8);
    }
  });

  it('never schedules a team twice in one week, so byes are real gaps', () => {
    for (const team of ROSTER) {
      const weeks = games
        .filter((game) =>
          [game.home, game.away].some((side) => side.team.providerTeamId === team.id),
        )
        .map((game) => game.week);
      expect(new Set(weeks).size).toBe(weeks.length);
    }
  });

  it('covers every state the board has to render', () => {
    const statuses = new Set(games.map((game) => game.status));
    for (const status of ['final', 'live', 'scheduled', 'postponed', 'canceled'] as const) {
      expect(statuses).toContain(status);
    }
    expect(games.some((game) => game.kickoffTbd)).toBe(true);
    expect(games.some((game) => game.neutralSite)).toBe(true);
  });

  it('keeps the §5 invariant: a verdict only on final games, scores only when played', () => {
    for (const game of games) {
      const final = game.status === 'final';
      expect(game.home.winner !== null).toBe(final);
      expect(game.home.score !== null).toBe(final || game.status === 'live');
    }
  });

  it('has live games at any hour, not just on Saturdays', () => {
    for (const hour of [3, 9, 15, 21]) {
      const at = Date.parse(`2026-10-06T${String(hour).padStart(2, '0')}:00:00Z`);
      expect(generateSeason(REGULAR, at).some((game) => game.status === 'live')).toBe(true);
    }
  });

  it('puts some teams on a bye in the current week', () => {
    const byes = ROSTER.filter((team) => {
      const own = games.filter((game) =>
        [game.home, game.away].some((side) => side.team.providerTeamId === team.id),
      );
      return (
        deriveSlots(own, team.id, { now: NOW, season: REGULAR, complete: true }).nextGame.kind ===
        'bye'
      );
    });
    expect(byes.length).toBeGreaterThan(0);
  });

  it('ends in a completed season in postseason mode (§22)', () => {
    const post = generateSeason({ year: 2026, type: 'postseason', week: null }, NOW);
    expect(post.every((game) => game.status === 'final' || game.status === 'canceled')).toBe(true);
  });

  it('encodes enough in a game id to rebuild the game', () => {
    const key = {
      year: 2026,
      type: 'regular' as const,
      currentWeek: 6,
      week: 4,
      home: 12,
      away: 37,
    };
    expect(decodeGameId(encodeGameId(key))).toEqual(key);
    expect(decodeGameId('401858226')).toBeNull();
  });
});

describe('MockProvider', () => {
  const mock = new MockProvider(() => NOW);

  it('agrees with itself: a game is the same game from both teams’ schedules', async () => {
    const alabama = await mock.getTeamSchedule('333', REGULAR);
    const first = alabama.games[0]!;
    const opponent =
      first.home.team.providerTeamId === '333'
        ? first.away.team.providerTeamId
        : first.home.team.providerTeamId;
    const theirs = await mock.getTeamSchedule(opponent, REGULAR);
    expect(theirs.games.find((game) => game.providerGameId === first.providerGameId)).toEqual(
      first,
    );
  });

  it('rebuilds any game from its id alone', async () => {
    const { games } = await mock.getTeamSchedule('61', REGULAR);
    for (const game of games) {
      await expect(mock.getGame(game.providerGameId)).resolves.toEqual(game);
    }
  });

  it('serves live games through slates, keyed the same way as kickoffs', async () => {
    const live = generateSeason(REGULAR, NOW).find((game) => game.status === 'live')!;
    const slate = await mock.getSlate(mock.slateKeyFor(live.kickoffUtc));
    expect(slate.map((game) => game.providerGameId)).toContain(live.providerGameId);
  });

  it('labels everything it makes up as mock, never as ESPN (§46)', async () => {
    const rankings = await mock.getRankings(REGULAR);
    expect(rankings?.poll).toBe('Mock Top 25');
    expect(rankings?.teams).toHaveLength(25);

    const { games } = await mock.getTeamSchedule('251', REGULAR);
    const predictions = await Promise.all(
      games.map((game) => mock.getPrediction(game.providerGameId)),
    );
    const present = predictions.filter((prediction) => prediction !== null);
    expect(present.length).toBeGreaterThan(0);
    for (const prediction of present) {
      expect(prediction.source).toBe('mock_predictor');
      expect(prediction.sourceLabel).toMatch(/mock/i);
      expect(prediction.homeWinPct + prediction.awayWinPct).toBeCloseTo(100, 5);
    }
  });

  it('has no team or game it was not asked to invent', async () => {
    await expect(mock.getTeamSchedule('999999', REGULAR)).rejects.toMatchObject({
      kind: 'not_found',
    });
    await expect(mock.getGame('12345')).rejects.toMatchObject({ kind: 'not_found' });
  });
});
