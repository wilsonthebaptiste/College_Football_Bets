import { describe, expect, it } from 'vitest';
import {
  finalGame,
  liveGame,
  makeGame,
  makePrediction,
  makeSnapshot,
  makeTeam,
} from '../test/fixtures';
import { predictionTarget, predictionView, viewedTeamOrder } from './prediction';

const team = makeTeam();
const ALABAMA = { providerTeamId: '333', name: 'Alabama' };

/** The team page's order for `game`: `viewed` first, against the game's opponent. */
const from = (viewed: { providerTeamId: string; name: string }, game = makeGame()) =>
  viewedTeamOrder(viewed, game);

describe('predictionTarget (§12: the relevant upcoming game)', () => {
  it('is the next game', () => {
    expect(predictionTarget(makeSnapshot(team))?.providerGameId).toBe('401000001');
  });

  it('is the game in progress, ahead of the next one', () => {
    const snapshot = makeSnapshot(team, { liveGame: liveGame() });
    expect(predictionTarget(snapshot)?.providerGameId).toBe('401000002');
  });

  it('is the game after a bye', () => {
    const following = makeGame({ providerGameId: 'after-bye' });
    const snapshot = makeSnapshot(team, { nextGame: { kind: 'bye', week: 5, following } });
    expect(predictionTarget(snapshot)?.providerGameId).toBe('after-bye');
  });

  it('is nothing when the season is over, or a bye has nothing after it', () => {
    expect(
      predictionTarget(
        makeSnapshot(team, { nextGame: { kind: 'none', reason: 'season_complete' } }),
      ),
    ).toBeNull();
    expect(
      predictionTarget(makeSnapshot(team, { nextGame: { kind: 'bye', week: 5, following: null } })),
    ).toBeNull();
  });

  it('is never a final or canceled game: a pregame number beside a result is not information', () => {
    expect(
      predictionTarget(makeSnapshot(team, { nextGame: { kind: 'game', game: finalGame() } })),
    ).toBeNull();
    expect(
      predictionTarget(
        makeSnapshot(team, {
          nextGame: { kind: 'game', game: makeGame({ status: 'canceled' }) },
        }),
      ),
    ).toBeNull();
  });
});

describe('predictionView', () => {
  const game = makeGame(); // Alabama at Tennessee

  it('puts the viewed team first, matched by provider id, never by position (§19)', () => {
    const view = predictionView(makePrediction(), game.providerGameId, from(ALABAMA, game));
    expect(view?.sides.map(({ name, pct, ours }) => [name, pct, ours])).toEqual([
      ['Alabama', 67, true],
      ['Tennessee', 33, false],
    ]);
  });

  it('works the same when the viewed team is at home', () => {
    const view = predictionView(
      makePrediction({
        homeWinPct: 71.5,
        awayWinPct: 28.5,
        home: { providerTeamId: '333', name: 'Alabama Crimson Tide', abbreviation: 'ALA' },
        away: { providerTeamId: '2633', name: 'Tennessee Volunteers', abbreviation: 'TENN' },
      }),
      '401000001',
      from(ALABAMA, makeGame({ homeAway: 'home' })),
    );
    expect(view?.sides.map(({ name, pct }) => `${name} ${String(pct)}`)).toEqual([
      'Alabama 71.5',
      'Tennessee 28.5',
    ]);
  });

  it('passes the provider’s numbers through unchanged, only scaling the bar', () => {
    const view = predictionView(
      makePrediction({ homeWinPct: 30, awayWinPct: 60 }),
      game.providerGameId,
      from(ALABAMA, game),
    );
    expect(view?.sides[0]).toMatchObject({ pct: 60, share: (60 / 90) * 100 });
    expect(view?.sides[1]).toMatchObject({ pct: 30, share: (30 / 90) * 100 });
  });

  it('refuses numbers that are not percentages rather than repairing them (§12)', () => {
    for (const [homeWinPct, awayWinPct] of [
      [Number.NaN, 50],
      [120, -20],
      [Number.POSITIVE_INFINITY, 0],
    ] as const) {
      expect(
        predictionView(
          makePrediction({ homeWinPct, awayWinPct }),
          game.providerGameId,
          from(ALABAMA, game),
        ),
      ).toBeNull();
    }
  });

  it('refuses a prediction for a different game', () => {
    expect(
      predictionView(
        makePrediction({ providerGameId: 'someone-else' }),
        game.providerGameId,
        from(ALABAMA, game),
      ),
    ).toBeNull();
  });

  it('shows the provider’s names, away first, when neither side is the viewed team', () => {
    const view = predictionView(
      makePrediction(),
      game.providerGameId,
      from({ providerTeamId: '999', name: 'X' }, game),
    );
    expect(view?.sides.map(({ name, ours }) => [name, ours])).toEqual([
      ['Alabama Crimson Tide', false],
      ['Tennessee', false],
    ]);
  });
});

describe('predictionView on a page that views neither team (the matchup page)', () => {
  // `makePrediction`: Alabama (away, 67%) at Tennessee (home, 33%).
  const awayHome = {
    kind: 'away_home' as const,
    away: { providerTeamId: '333', name: 'Alabama' },
    home: { providerTeamId: '2633', name: 'Tennessee' },
  };

  it('lists away first, then home, under the page’s names, with neither marked as ours', () => {
    const view = predictionView(makePrediction(), '401000001', awayHome);
    expect(view?.sides.map(({ name, pct, ours }) => [name, pct, ours])).toEqual([
      ['Alabama', 67, false],
      ['Tennessee', 33, false],
    ]);
  });

  it('matches sides by provider id, not by the prediction’s own home and away (§19)', () => {
    const swapped = makePrediction({
      homeWinPct: 67,
      awayWinPct: 33,
      home: { providerTeamId: '333', name: 'Alabama Crimson Tide', abbreviation: 'ALA' },
      away: { providerTeamId: '2633', name: 'Tennessee Volunteers', abbreviation: 'TENN' },
    });
    const view = predictionView(swapped, '401000001', awayHome);
    expect(view?.sides.map(({ name, pct }) => `${name} ${String(pct)}`)).toEqual([
      'Alabama 67',
      'Tennessee 33',
    ]);
  });

  it('refuses the same things the team page refuses', () => {
    expect(predictionView(makePrediction(), 'another-game', awayHome)).toBeNull();
    expect(
      predictionView(makePrediction({ homeWinPct: Number.NaN }), '401000001', awayHome),
    ).toBeNull();
  });
});
