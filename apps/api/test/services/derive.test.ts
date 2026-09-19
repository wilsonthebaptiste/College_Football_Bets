import { describe, expect, it } from 'vitest';
import { deriveSlots, inLiveWindow, scheduleItems } from '../../src/services/derive';
import { toTeamGame } from '../../src/services/perspective';
import { NOW, SEASON, US, daysFromNow, game, hoursFromNow, record } from '../helpers/games';

/**
 * §9, §10, §11, §22 — previous, next, live, bye, and season-complete, against
 * hand-built schedules where every edge is exactly where the test says.
 */

const options = { now: NOW, season: SEASON, complete: true };

describe('previous game (§9)', () => {
  it('is the latest FINAL game strictly before now', () => {
    const slots = deriveSlots(
      [
        game({
          week: 1,
          kickoff: daysFromNow(-18),
          status: 'final',
          us: 21,
          them: 14,
          record: record('1-0'),
        }),
        game({
          week: 2,
          kickoff: daysFromNow(-11),
          status: 'final',
          us: 10,
          them: 28,
          record: record('1-1'),
        }),
        game({ week: 3, kickoff: daysFromNow(3) }),
      ],
      US,
      options,
    );
    expect(slots.previousGame).toMatchObject({
      week: 2,
      result: 'L',
      teamScore: 10,
      opponentScore: 28,
    });
    expect(slots.record?.summary).toBe('1-1');
  });

  it('is never the live game, which is reported separately (§9, §11)', () => {
    const slots = deriveSlots(
      [
        game({
          week: 1,
          kickoff: daysFromNow(-7),
          status: 'final',
          us: 30,
          them: 3,
          record: record('1-0'),
        }),
        game({ week: 2, kickoff: hoursFromNow(-1), status: 'live', us: 7, them: 10 }),
      ],
      US,
      options,
    );
    expect(slots.previousGame?.week).toBe(1);
    expect(slots.liveGame).toMatchObject({ week: 2, status: 'live', result: null, teamScore: 7 });
    // The record is the one reported after the last FINAL, not a live tally.
    expect(slots.record?.summary).toBe('1-0');
  });

  it('has no record at all rather than an older one, if the latest final omits it', () => {
    const slots = deriveSlots(
      [
        game({
          week: 1,
          kickoff: daysFromNow(-14),
          status: 'final',
          us: 1,
          them: 0,
          record: record('1-0'),
        }),
        game({ week: 2, kickoff: daysFromNow(-7), status: 'final', us: 1, them: 0, record: null }),
      ],
      US,
      options,
    );
    expect(slots.record).toBeNull();
  });
});

describe('next game (§10)', () => {
  it('skips canceled games and lapsed postponements', () => {
    const slots = deriveSlots(
      [
        game({ week: 4, kickoff: daysFromNow(-3), status: 'postponed' }),
        game({ week: 5, kickoff: daysFromNow(3), status: 'canceled' }),
        game({ week: 6, kickoff: daysFromNow(10) }),
      ],
      US,
      options,
    );
    expect(slots.nextGame).toMatchObject({ kind: 'game', game: { week: 6 } });
  });

  it('includes a postponed game once it has a future date', () => {
    const slots = deriveSlots(
      [game({ week: 5, kickoff: daysFromNow(2), status: 'postponed' })],
      US,
      options,
    );
    expect(slots.nextGame).toMatchObject({ kind: 'game', game: { status: 'postponed' } });
  });

  it('keeps a game "next" for a few hours past kickoff if the provider has not caught up', () => {
    const slots = deriveSlots([game({ week: 5, kickoff: hoursFromNow(-2) })], US, options);
    expect(slots.nextGame).toMatchObject({ kind: 'game', game: { week: 5, status: 'scheduled' } });
  });

  it('is the game AFTER a live one', () => {
    const slots = deriveSlots(
      [
        game({ week: 5, kickoff: hoursFromNow(-1), status: 'live' }),
        game({ week: 6, kickoff: daysFromNow(7) }),
      ],
      US,
      options,
    );
    expect(slots.nextGame).toMatchObject({ kind: 'game', game: { week: 6 } });
  });

  it('says "season complete" when every game is done (§22)', () => {
    const slots = deriveSlots(
      [
        game({
          week: 11,
          kickoff: daysFromNow(-14),
          status: 'final',
          us: 20,
          them: 17,
          record: record('9-2'),
        }),
        game({ week: 12, kickoff: daysFromNow(-7), status: 'canceled' }),
      ],
      US,
      options,
    );
    expect(slots.nextGame).toEqual({ kind: 'none', reason: 'season_complete' });
    expect(slots.previousGame?.week).toBe(11);
    expect(slots.record?.summary).toBe('9-2');
  });

  it('says "no upcoming game" for an empty schedule, not "season complete"', () => {
    expect(deriveSlots([], US, options).nextGame).toEqual({ kind: 'none', reason: 'no_upcoming' });
  });

  it('is not "season complete" while the last game is still live', () => {
    const slots = deriveSlots(
      [game({ week: 12, kickoff: hoursFromNow(-1), status: 'live' })],
      US,
      options,
    );
    expect(slots.nextGame).toEqual({ kind: 'none', reason: 'no_upcoming' });
  });
});

describe('bye weeks (§10, §22)', () => {
  const schedule = [
    game({ week: 3, kickoff: daysFromNow(-11), status: 'final', us: 1, them: 0 }),
    game({ week: 4, kickoff: daysFromNow(-4), status: 'final', us: 1, them: 0 }),
    game({ week: 6, kickoff: daysFromNow(10) }),
  ];

  it('knows this week is a bye from the provider calendar, and names the next game', () => {
    const slots = deriveSlots(schedule, US, { ...options, season: { ...SEASON, week: 5 } });
    expect(slots.nextGame).toMatchObject({ kind: 'bye', week: 5, following: { week: 6 } });
  });

  it('is not a bye when the team does play in the calendar week', () => {
    const slots = deriveSlots(schedule, US, { ...options, season: { ...SEASON, week: 6 } });
    expect(slots.nextGame.kind).toBe('game');
  });

  it('is not a bye before the team’s first game (week 0 is not a bye for a week-1 team)', () => {
    const slots = deriveSlots([game({ week: 1, kickoff: daysFromNow(5) })], US, {
      ...options,
      season: { ...SEASON, week: 0 },
    });
    expect(slots.nextGame.kind).toBe('game');
  });

  it('falls back to the week gap when there is no calendar week', () => {
    const slots = deriveSlots(schedule, US, options);
    expect(slots.nextGame).toMatchObject({ kind: 'bye', week: 5 });
  });

  it('without a calendar week, a gap is not a bye if the next game is this week', () => {
    const soon = [...schedule.slice(0, 2), game({ week: 6, kickoff: daysFromNow(3) })];
    expect(deriveSlots(soon, US, options).nextGame.kind).toBe('game');
  });

  it('infers nothing from gaps in a schedule the provider sent incomplete', () => {
    const slots = deriveSlots(schedule, US, {
      ...options,
      season: { ...SEASON, week: 5 },
      complete: false,
    });
    expect(slots.nextGame.kind).toBe('game');
  });

  it('is never a bye in the postseason', () => {
    const slots = deriveSlots(schedule, US, {
      ...options,
      season: { ...SEASON, type: 'postseason', week: 1 },
    });
    expect(slots.nextGame.kind).toBe('game');
  });

  it('puts bye rows in the full schedule (§17), and none for a gapless one', () => {
    const items = scheduleItems(schedule, US, true);
    expect(items.map((item) => (item.kind === 'bye' ? 'bye' : item.game.week))).toEqual([
      3,
      4,
      'bye',
      6,
    ]);
    expect(scheduleItems(schedule, US, false).some((item) => item.kind === 'bye')).toBe(false);
  });
});

describe('perspective (§19, the §5 invariant)', () => {
  it('reports the provider’s own home/away, and neutral over either', () => {
    expect(toTeamGame(game({ week: 1, kickoff: daysFromNow(1), home: false }), US)?.homeAway).toBe(
      'away',
    );
    expect(
      toTeamGame(game({ week: 1, kickoff: daysFromNow(1), neutral: true }), US)?.homeAway,
    ).toBe('neutral');
  });

  it('sets a result only on a final game', () => {
    for (const status of [
      'scheduled',
      'live',
      'postponed',
      'canceled',
      'delayed',
      'suspended',
    ] as const) {
      expect(
        toTeamGame(game({ week: 1, kickoff: daysFromNow(-1), status }), US)?.result,
      ).toBeNull();
    }
    expect(
      toTeamGame(game({ week: 1, kickoff: daysFromNow(-1), status: 'final', us: 3, them: 3 }), US)
        ?.result,
    ).toBe('T');
  });

  it('is null for a team that is not in the game', () => {
    expect(toTeamGame(game({ week: 1, kickoff: daysFromNow(1) }), 'someone-else')).toBeNull();
  });
});

describe('live window', () => {
  it('covers a scheduled game from kickoff to six hours after', () => {
    expect(inLiveWindow(game({ week: 1, kickoff: hoursFromNow(1) }), NOW)).toBe(false);
    expect(inLiveWindow(game({ week: 1, kickoff: hoursFromNow(-1) }), NOW)).toBe(true);
    expect(inLiveWindow(game({ week: 1, kickoff: hoursFromNow(-7) }), NOW)).toBe(false);
  });

  it('ignores a TBD kickoff’s placeholder time, and anything already final', () => {
    expect(inLiveWindow(game({ week: 1, kickoff: hoursFromNow(-1), tbd: true }), NOW)).toBe(false);
    expect(inLiveWindow(game({ week: 1, kickoff: hoursFromNow(-1), status: 'final' }), NOW)).toBe(
      false,
    );
  });
});
