import { describe, expect, it } from 'vitest';
import {
  finalMatchup,
  freshness,
  JORDAN,
  liveMatchup,
  makeMatchup,
  makeTeam,
  matchupBoardResponse,
  STEPH,
  WILSON,
} from '../test/fixtures';
import { formatGameDay, gameDayKey } from './format';
import {
  adjacentWeeks,
  groupMatchups,
  isInProgress,
  matchupPath,
  matchupTitle,
  rankingPollOfMatchups,
  resultOf,
  sameOwnerNote,
  scoreState,
  sectionOf,
  summarizeMatchupFreshness,
  teamPath,
  weekLabel,
  weekPath,
} from './matchup';

/**
 * The rules the matchup screens apply to the API's rows (plan-matchup-board,
 * Phase 2), each pinned on its own so a screen test failing says which rule.
 */

describe('sections (§51: what is happening now, first)', () => {
  it('puts a game in progress — including a mid-game delay — under Live now', () => {
    expect(sectionOf(liveMatchup())).toBe('live');
    expect(sectionOf(makeMatchup({ status: 'delayed', period: 3 }))).toBe('live');
    expect(sectionOf(makeMatchup({ status: 'suspended', period: 2 }))).toBe('live');
    expect(isInProgress(makeMatchup({ status: 'delayed', period: null }))).toBe(false);
  });

  it('keeps a pregame delay, an unknown status, and a TBD kickoff under Upcoming', () => {
    expect(sectionOf(makeMatchup({ status: 'delayed' }))).toBe('upcoming');
    expect(sectionOf(makeMatchup({ status: 'unknown' }))).toBe('upcoming');
    expect(sectionOf(makeMatchup({ kickoffTbd: true }))).toBe('upcoming');
  });

  it('files finals, then postponed and canceled games, last', () => {
    expect(sectionOf(finalMatchup())).toBe('final');
    expect(sectionOf(makeMatchup({ status: 'postponed' }))).toBe('off');
    expect(sectionOf(makeMatchup({ status: 'canceled' }))).toBe('off');
  });
});

describe('upcoming days, in the viewer’s own zone', () => {
  // 11:30 PM Eastern on Saturday is 03:30 UTC on Sunday.
  const lateSaturday = makeMatchup({ providerGameId: 'late', kickoffUtc: '2026-10-11T03:30:00Z' });
  const noonSaturday = makeMatchup({ providerGameId: 'noon', kickoffUtc: '2026-10-10T16:00:00Z' });
  const tbdSaturday = makeMatchup({
    providerGameId: 'tbd',
    // ESPN's placeholder for a TBD kickoff: midnight Eastern.
    kickoffUtc: '2026-10-10T04:00:00Z',
    kickoffTbd: true,
  });
  const thursday = makeMatchup({ providerGameId: 'thu', kickoffUtc: '2026-10-08T23:30:00Z' });
  // The server's order: Eastern days, TBD last within its day.
  const rows = [thursday, noonSaturday, lateSaturday, tbdSaturday];

  it('keeps a late Saturday kickoff on Saturday for a viewer in Eastern or Pacific', () => {
    for (const timeZone of ['America/New_York', 'America/Los_Angeles']) {
      const days = groupMatchups(rows, { timeZone }).upcoming;
      expect(days.map((day) => day.key)).toEqual(['2026-10-08', '2026-10-10']);
      expect(days[1]?.rows.map((row) => row.providerGameId)).toEqual(['noon', 'late', 'tbd']);
    }
  });

  it('moves it to Sunday for a viewer in London, as their calendar says', () => {
    const days = groupMatchups(rows, { timeZone: 'Europe/London' }).upcoming;
    // Thursday's 7:30 PM Eastern kickoff is past midnight in London, too.
    expect(days.map((day) => day.key)).toEqual(['2026-10-09', '2026-10-10', '2026-10-11']);
    expect(days[2]?.rows.map((row) => row.providerGameId)).toEqual(['late']);
  });

  it('reads a TBD kickoff’s day in Eastern, so a placeholder midnight never lands a day early', () => {
    expect(gameDayKey(tbdSaturday, { timeZone: 'America/Los_Angeles' })).toBe('2026-10-10');
    expect(gameDayKey(tbdSaturday, { timeZone: 'Pacific/Honolulu' })).toBe('2026-10-10');
  });

  it('keeps the server’s order inside a day, which is what keeps TBD last', () => {
    const day = groupMatchups(rows, { timeZone: 'America/Chicago' }).upcoming[1];
    expect(day?.rows.at(-1)?.providerGameId).toBe('tbd');
  });

  it('names each day in full, as a calendar day, not a converted instant', () => {
    expect(formatGameDay('2026-10-10')).toBe('Saturday, October 10');
    expect(groupMatchups([thursday], { timeZone: 'UTC' }).upcoming[0]?.label).toBe(
      'Thursday, October 8',
    );
  });

  it('puts a kickoff that is not a date in a group of its own, last', () => {
    const broken = makeMatchup({ providerGameId: 'broken', kickoffUtc: 'not a date' });
    const days = groupMatchups([broken, noonSaturday], { timeZone: 'UTC' }).upcoming;
    expect(days.map((day) => day.label)).toEqual(['Saturday, October 10', 'Date to be announced']);
  });
});

describe('the matchup’s name (§19)', () => {
  it('is "away at home", from the provider’s own designation', () => {
    expect(matchupTitle(makeMatchup())).toBe('Ohio State at Iowa');
  });

  it('is "vs" at a neutral site', () => {
    expect(matchupTitle(makeMatchup({ neutralSite: true }))).toBe('Ohio State vs Iowa');
  });

  it('falls back to the full name when there is no short one', () => {
    const row = makeMatchup();
    const away = { ...row.away, team: makeTeam({ name: 'Texas Longhorns', displayName: null }) };
    expect(matchupTitle({ ...row, away })).toBe('Texas Longhorns at Iowa');
  });
});

describe('one person on both sides', () => {
  it('says so in words, by name', () => {
    const row = makeMatchup({ sameOwner: true });
    const both = { ...row, home: { ...row.home, owners: [WILSON] } };
    expect(sameOwnerNote(both)).toBe("Both Wilson's");
  });

  it('names two people who both have both sides, sorted', () => {
    const row = makeMatchup({ sameOwner: true });
    const both = {
      ...row,
      away: { ...row.away, owners: [JORDAN, WILSON] },
      home: { ...row.home, owners: [JORDAN, STEPH, WILSON] },
    };
    expect(sameOwnerNote(both)).toBe("Both Jordan's and Wilson's");
  });

  it('says nothing for an ordinary matchup, and matches people by id, not name', () => {
    expect(sameOwnerNote(makeMatchup())).toBeNull();
    const row = makeMatchup({ sameOwner: false });
    const twins = {
      ...row,
      home: { ...row.home, owners: [{ userId: 'someone-else', displayName: 'Wilson' }] },
    };
    expect(sameOwnerNote(twins)).toBeNull();
  });
});

describe('results and scores (§4, §11)', () => {
  it('marks the winner and the loser only once the provider says final', () => {
    const row = finalMatchup();
    expect([resultOf(row, 'away'), resultOf(row, 'home')]).toEqual(['W', 'L']);
    expect(resultOf(liveMatchup(), 'away')).toBeNull();
  });

  it('never infers a tie from two missing winners', () => {
    const row = finalMatchup();
    const gap = {
      ...row,
      away: { ...row.away, winner: false },
      home: { ...row.home, winner: false },
    };
    expect([resultOf(gap, 'away'), resultOf(gap, 'home')]).toEqual([null, null]);
  });

  it('tells a missing score from a failed row from no score yet', () => {
    expect(scoreState(liveMatchup())).toBe('scores');
    expect(scoreState(finalMatchup())).toBe('scores');
    const live = liveMatchup();
    expect(scoreState({ ...live, home: { ...live.home, score: null } })).toBe('missing');
    expect(scoreState(liveMatchup({ freshness: freshness('unavailable') }))).toBe('failed');
    expect(scoreState(makeMatchup())).toBe('none');
    expect(scoreState(makeMatchup({ status: 'postponed' }))).toBe('none');
  });
});

describe('the header’s "Last updated" (§23, §39)', () => {
  it('is the OLDEST row’s time, not the newest live score’s', () => {
    const board = matchupBoardResponse([
      liveMatchup(),
      makeMatchup({ freshness: freshness('cached', '2026-10-10T17:45:00.000Z') }),
    ]);
    expect(summarizeMatchupFreshness(board)).toEqual({
      oldestFetchedAt: '2026-10-10T17:45:00.000Z',
      anyStale: false,
    });
  });

  it('is stale when any row is, or the week is', () => {
    const staleRow = matchupBoardResponse([
      liveMatchup({ freshness: freshness('stale', '2026-10-10T20:00:00.000Z') }),
    ]);
    expect(summarizeMatchupFreshness(staleRow).anyStale).toBe(true);
    const staleWeek = matchupBoardResponse([], { freshness: freshness('stale') });
    expect(summarizeMatchupFreshness(staleWeek)).toMatchObject({ anyStale: true });
  });

  it('is the week’s own time when there are no rows, and nothing when nothing has one', () => {
    expect(summarizeMatchupFreshness(matchupBoardResponse([])).oldestFetchedAt).toBe(
      '2026-10-10T17:59:00.000Z',
    );
    const failed = matchupBoardResponse([liveMatchup({ freshness: freshness('unavailable') })]);
    expect(summarizeMatchupFreshness(failed).oldestFetchedAt).toBeNull();
  });

  it('names the poll once, from the first ranked side, and nothing when nobody is ranked', () => {
    expect(rankingPollOfMatchups([makeMatchup()])).toBe('AP Top 25');
    const row = makeMatchup();
    const unranked = { ...row, away: { ...row.away, ranking: { kind: 'unavailable' as const } } };
    expect(rankingPollOfMatchups([unranked])).toBeNull();
  });
});

describe('weeks', () => {
  const regular = { year: 2026, type: 'regular', week: 6 } as const;
  const post = { year: 2026, type: 'postseason', week: 1 } as const;
  const bowls = [
    { week: 1, label: 'Bowls', startUtc: '', endUtc: '' },
    { week: 999, label: 'CFP', startUtc: '', endUtc: '' },
  ];

  it('prints the calendar’s own label, never "Week 999"', () => {
    expect(weekLabel(post, 999, bowls)).toBe('CFP');
    expect(weekLabel(post, 1, bowls)).toBe('Bowls');
    expect(weekLabel(post, 7, [])).toBe('Postseason');
    expect(weekLabel(regular, 6, [])).toBe('Week 6');
  });

  it('finds the weeks either side in the calendar’s order, and none at the ends', () => {
    const { weeks } = matchupBoardResponse([]);
    expect(adjacentWeeks(6, weeks)).toMatchObject({ previous: { week: 5 }, next: { week: 7 } });
    expect(adjacentWeeks(5, weeks)).toMatchObject({ previous: null, next: { week: 6 } });
    expect(adjacentWeeks(999, bowls)).toMatchObject({ previous: { week: 1 }, next: null });
  });

  it('offers no links with no calendar, or with no week', () => {
    expect(adjacentWeeks(6, [])).toEqual({ previous: null, next: null });
    expect(adjacentWeeks(null, matchupBoardResponse([]).weeks)).toEqual({
      previous: null,
      next: null,
    });
  });
});

describe('addresses', () => {
  it('links a week, a game, and a team by the ids the API takes', () => {
    expect(weekPath(4)).toBe('/matchups?week=4');
    expect(matchupPath('401500001')).toBe('/matchups/401500001');
    const row = makeMatchup();
    expect(teamPath(row.away)).toBe(`/teams/${row.away.team.id ?? ''}`);
    // A side nobody has (single-game read) has no uuid: the provider's id still opens it.
    const nobody = { ...row.home, team: { ...row.home.team, id: null }, owners: [] };
    expect(teamPath(nobody)).toBe('/teams/2294');
  });
});
