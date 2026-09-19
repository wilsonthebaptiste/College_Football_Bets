import { describe, expect, it } from 'vitest';
import type { Game, ScheduleItem } from '@cfb/shared';
import {
  envelope,
  finalGame,
  liveGame,
  makeBoard,
  makeBoardTeam,
  makeGame,
  makeSnapshot,
  makeTeam,
  NOW,
  PROVIDER_DOWN,
  scheduleResponse,
} from '../test/fixtures';
import { boardPollInterval, POLL, pollIntervalFor, schedulePollInterval } from './poll';

const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

function cardWithNextKickoff(offsetMs: number, tbd = false) {
  const team = makeTeam();
  return makeBoardTeam(
    envelope(
      makeSnapshot(team, {
        nextGame: { kind: 'game', game: makeGame({ kickoffUtc: at(offsetMs), kickoffTbd: tbd }) },
      }),
    ),
    team,
  );
}

describe('POLL (§24: centralized intervals)', () => {
  it('matches the Worker’s board TTLs, so polling never outruns the server cache', () => {
    expect(POLL.liveMs).toBe(15_000);
    expect(POLL.activeMs).toBe(60_000);
    expect(POLL.idleMs).toBeGreaterThan(POLL.activeMs);
    // The dedupe window is shorter than the fastest interval, or live polling would stall.
    expect(POLL.staleTimeMs).toBeLessThan(POLL.liveMs);
  });
});

describe('boardPollInterval', () => {
  it('polls fastest while any team is live, on the server’s word (anyLive)', () => {
    const board = makeBoard([cardWithNextKickoff(3 * 24 * HOUR)], { anyLive: true });
    expect(boardPollInterval(board, NOW)).toBe(POLL.liveMs);
  });

  it('treats a card with a live game as live even if anyLive were missing', () => {
    const team = makeTeam();
    const live = makeBoardTeam(envelope(makeSnapshot(team, { liveGame: liveGame() })), team);
    expect(boardPollInterval(makeBoard([live], { anyLive: false }), NOW)).toBe(POLL.liveMs);
  });

  it('is active when a kickoff is within the next 12 hours', () => {
    expect(boardPollInterval(makeBoard([cardWithNextKickoff(3 * HOUR)]), NOW)).toBe(POLL.activeMs);
  });

  it('is active when a kickoff has passed but the game is not yet reported live', () => {
    expect(boardPollInterval(makeBoard([cardWithNextKickoff(-1 * HOUR)]), NOW)).toBe(POLL.activeMs);
  });

  it('idles when nothing is on for the next 12 hours', () => {
    const board = makeBoard([cardWithNextKickoff(2 * 24 * HOUR), cardWithNextKickoff(20 * HOUR)]);
    expect(boardPollInterval(board, NOW)).toBe(POLL.idleMs);
  });

  it('never treats a TBD placeholder time as a real kickoff', () => {
    expect(boardPollInterval(makeBoard([cardWithNextKickoff(HOUR, true)]), NOW)).toBe(POLL.idleMs);
  });

  it('counts the game after a bye', () => {
    const team = makeTeam();
    const bye = makeBoardTeam(
      envelope(
        makeSnapshot(team, {
          nextGame: { kind: 'bye', week: 5, following: makeGame({ kickoffUtc: at(2 * HOUR) }) },
        }),
      ),
      team,
    );
    expect(boardPollInterval(makeBoard([bye]), NOW)).toBe(POLL.activeMs);
  });

  it('keeps retrying at the active pace while a card is failing or stale', () => {
    const failing = makeBoardTeam(envelope(null, 'unavailable', PROVIDER_DOWN));
    expect(boardPollInterval(makeBoard([failing]), NOW)).toBe(POLL.activeMs);

    const team = makeTeam();
    const stale = makeBoardTeam(
      envelope(
        makeSnapshot(team, { nextGame: { kind: 'none', reason: 'season_complete' } }),
        'stale',
      ),
      team,
    );
    expect(boardPollInterval(makeBoard([stale]), NOW)).toBe(POLL.activeMs);
  });

  it('idles through the offseason', () => {
    const team = makeTeam();
    const done = makeBoardTeam(
      envelope(makeSnapshot(team, { nextGame: { kind: 'none', reason: 'season_complete' } })),
      team,
    );
    expect(boardPollInterval(makeBoard([done]), NOW)).toBe(POLL.idleMs);
  });

  it('idles on an empty board', () => {
    expect(pollIntervalFor([], NOW)).toBe(POLL.idleMs);
  });
});

describe('schedulePollInterval (the team page’s schedule, §24)', () => {
  const team = makeTeam();
  const schedule = (games: Game[], state: 'fresh' | 'stale' = 'fresh') =>
    scheduleResponse(
      team,
      games.map((game): ScheduleItem => ({ kind: 'game', game })),
      state,
    ).schedule;

  it('follows a live row at the live pace', () => {
    expect(schedulePollInterval(schedule([finalGame(), liveGame()]), NOW)).toBe(POLL.liveMs);
  });

  it('is active on a game day, idle in a quiet week', () => {
    const soon = makeGame({ kickoffUtc: at(3 * HOUR) });
    const later = makeGame({ kickoffUtc: at(4 * 24 * HOUR) });
    expect(schedulePollInterval(schedule([finalGame(), soon]), NOW)).toBe(POLL.activeMs);
    expect(schedulePollInterval(schedule([finalGame(), later]), NOW)).toBe(POLL.idleMs);
  });

  it('is not woken by old results, TBD placeholders, or a lapsed postponement', () => {
    const games = [
      finalGame({ kickoffUtc: at(-2 * HOUR) }),
      makeGame({ kickoffUtc: at(HOUR), kickoffTbd: true }),
      makeGame({ kickoffUtc: at(-HOUR), status: 'postponed' }),
      makeGame({ kickoffUtc: at(-30 * 24 * HOUR) }),
    ];
    expect(schedulePollInterval(schedule(games), NOW)).toBe(POLL.idleMs);
  });

  it('retries at the active pace while failing or stale, so it recovers by itself', () => {
    expect(schedulePollInterval(scheduleResponse(team, [], 'unavailable').schedule, NOW)).toBe(
      POLL.activeMs,
    );
    expect(schedulePollInterval(schedule([finalGame()], 'stale'), NOW)).toBe(POLL.activeMs);
  });

  it('idles through a finished season', () => {
    expect(schedulePollInterval(schedule([finalGame(), finalGame()]), NOW)).toBe(POLL.idleMs);
  });
});

describe('POLL.predictionMs', () => {
  it('rereads a prediction slowly: it does not move once published', () => {
    expect(POLL.predictionMs).toBeGreaterThanOrEqual(POLL.activeMs);
  });
});
