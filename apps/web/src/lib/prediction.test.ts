import { describe, expect, it } from 'vitest';
import {
  finalGame,
  liveGame,
  makeGame,
  makePrediction,
  makeSnapshot,
  makeTeam,
} from '../test/fixtures';
import { predictionTarget, predictionView } from './prediction';

const team = makeTeam();
const ALABAMA = { providerTeamId: '333', name: 'Alabama' };

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
    const view = predictionView(makePrediction(), game, ALABAMA);
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
      makeGame({ homeAway: 'home' }),
      ALABAMA,
    );
    expect(view?.sides.map(({ name, pct }) => `${name} ${String(pct)}`)).toEqual([
      'Alabama 71.5',
      'Tennessee 28.5',
    ]);
  });

  it('passes the provider’s numbers through unchanged, only scaling the bar', () => {
    const view = predictionView(makePrediction({ homeWinPct: 30, awayWinPct: 60 }), game, ALABAMA);
    expect(view?.sides[0]).toMatchObject({ pct: 60, share: (60 / 90) * 100 });
    expect(view?.sides[1]).toMatchObject({ pct: 30, share: (30 / 90) * 100 });
  });

  it('refuses numbers that are not percentages rather than repairing them (§12)', () => {
    for (const [homeWinPct, awayWinPct] of [
      [Number.NaN, 50],
      [120, -20],
      [Number.POSITIVE_INFINITY, 0],
    ] as const) {
      expect(predictionView(makePrediction({ homeWinPct, awayWinPct }), game, ALABAMA)).toBeNull();
    }
  });

  it('refuses a prediction for a different game', () => {
    expect(
      predictionView(makePrediction({ providerGameId: 'someone-else' }), game, ALABAMA),
    ).toBeNull();
  });

  it('shows the provider’s names, away first, when neither side is the viewed team', () => {
    const view = predictionView(makePrediction(), game, { providerTeamId: '999', name: 'X' });
    expect(view?.sides.map(({ name, ours }) => [name, ours])).toEqual([
      ['Alabama Crimson Tide', false],
      ['Tennessee', false],
    ]);
  });
});
