import { describe, expect, it } from 'vitest';
import { finalGame, liveGame, makeGame } from '../test/fixtures';
import {
  formatGameDate,
  formatKickoff,
  formatScore,
  formatSeason,
  formatUpdatedAt,
  initials,
  liveSituation,
  statusLabel,
  teamLabel,
} from './format';

const CHICAGO = 'America/Chicago';
const LA = 'America/Los_Angeles';
/** Thursday 1 October, 1 PM in Chicago. */
const NOW = Date.parse('2026-10-01T18:00:00Z');

describe('formatKickoff (§20: UTC in the data, local time on screen)', () => {
  it('shows weekday, date, and local time', () => {
    const game = makeGame({ kickoffUtc: '2026-10-03T20:30:00.000Z' });
    expect(formatKickoff(game, { now: NOW, timeZone: CHICAGO })).toBe('Sat, Oct 3, 3:30 PM');
    expect(formatKickoff(game, { now: NOW, timeZone: LA })).toBe('Sat, Oct 3, 1:30 PM');
  });

  it('says Today and Tomorrow in the viewer’s own zone', () => {
    const tonight = makeGame({ kickoffUtc: '2026-10-02T00:00:00.000Z' });
    expect(formatKickoff(tonight, { now: NOW, timeZone: CHICAGO })).toBe('Today, 7:00 PM');

    const tomorrow = makeGame({ kickoffUtc: '2026-10-02T23:00:00.000Z' });
    expect(formatKickoff(tomorrow, { now: NOW, timeZone: CHICAGO })).toBe('Tomorrow, 6:00 PM');
  });

  it('finds "tomorrow" by the calendar, not by adding 24 hours, across a DST change', () => {
    // US clocks spring forward early on Sunday 8 March. From Saturday 11:30 PM
    // Central, 24 hours of real time lands on MONDAY 12:30 AM, so "now + 24 h"
    // would call Sunday's game a plain date. The calendar says tomorrow.
    const saturdayLate = Date.parse('2026-03-08T05:30:00Z'); // Sat 7 Mar, 11:30 PM CST
    const sunday = makeGame({ kickoffUtc: '2026-03-08T17:00:00.000Z' }); // Sun 12:00 PM CDT
    expect(formatKickoff(sunday, { now: saturdayLate, timeZone: CHICAGO })).toBe(
      'Tomorrow, 12:00 PM',
    );
  });

  it('never shows the placeholder time of a TBD kickoff (§4)', () => {
    // ESPN-style placeholder: midnight US Eastern on the game day.
    const tbd = makeGame({ kickoffUtc: '2026-10-10T04:00:00.000Z', kickoffTbd: true });
    const text = formatKickoff(tbd, { now: NOW, timeZone: LA });
    expect(text).toBe('Sat, Oct 10, time TBD');
    expect(text).not.toMatch(/\d:\d\d/);
  });

  it('keeps a TBD game on its own date even for a viewer west of Eastern', () => {
    // Midnight Eastern is 9 PM the day before in Los Angeles. The game is on
    // the 10th, whatever the viewer's zone.
    const tbd = makeGame({ kickoffUtc: '2026-10-10T04:00:00.000Z', kickoffTbd: true });
    expect(formatKickoff(tbd, { now: NOW, timeZone: LA })).toContain('Oct 10');
    expect(formatGameDate(tbd, { timeZone: LA })).toBe('Sat, Oct 10');
  });

  it('degrades to words, not "Invalid Date", when the timestamp is unreadable', () => {
    const broken = makeGame({ kickoffUtc: 'not a date' });
    expect(formatKickoff(broken, { now: NOW })).toBe('Date to be announced');
    expect(formatGameDate(broken)).toBe('Date unavailable');
  });
});

describe('formatUpdatedAt (§23: "Last updated: 3:42 PM")', () => {
  it('is a time alone when it is from today', () => {
    expect(formatUpdatedAt('2026-10-01T20:42:00.000Z', { now: NOW, timeZone: CHICAGO })).toBe(
      '3:42 PM',
    );
  });

  it('adds the date when it is not from today, so old data cannot pass for new', () => {
    expect(formatUpdatedAt('2026-09-29T20:42:00.000Z', { now: NOW, timeZone: CHICAGO })).toBe(
      'Sep 29, 3:42 PM',
    );
  });

  it('returns null rather than inventing a time', () => {
    expect(formatUpdatedAt(null)).toBeNull();
    expect(formatUpdatedAt('garbage')).toBeNull();
  });
});

describe('formatSeason', () => {
  it('names the season from the data (§21)', () => {
    expect(formatSeason({ year: 2026, type: 'regular', week: 5 })).toBe('2026 season, week 5');
    expect(formatSeason({ year: 2026, type: 'regular', week: null })).toBe('2026 season');
    expect(formatSeason({ year: 2025, type: 'postseason', week: null })).toBe('2025 postseason');
    expect(formatSeason({ year: 2027, type: 'preseason', week: null })).toBe('2027 preseason');
  });
});

describe('scores and statuses', () => {
  it('tells the score from the team’s side, with an en dash', () => {
    expect(formatScore(31, 24)).toBe('31–24');
  });

  it('labels only the statuses a card must call out', () => {
    expect(statusLabel(makeGame())).toBeNull();
    expect(statusLabel(finalGame())).toBeNull();
    expect(statusLabel(makeGame({ status: 'postponed' }))).toBe('Postponed');
    expect(statusLabel(makeGame({ status: 'canceled' }))).toBe('Canceled');
    expect(statusLabel(makeGame({ status: 'delayed' }))).toBe('Delayed');
    expect(statusLabel(makeGame({ status: 'suspended' }))).toBe('Suspended');
  });

  it('shows an unknown status neutrally, in the provider’s words when it has some (§18)', () => {
    expect(statusLabel(makeGame({ status: 'unknown', statusDetail: 'Forfeit' }))).toBe('Forfeit');
    expect(statusLabel(makeGame({ status: 'unknown', statusDetail: null }))).toBe('Status unknown');
  });

  it('prefers the provider’s live wording, so halftime reads as halftime', () => {
    expect(liveSituation(liveGame({ statusDetail: 'Halftime', period: 2, clock: '0:00' }))).toBe(
      'Halftime',
    );
    expect(liveSituation(liveGame({ statusDetail: null, period: 3, clock: '4:32' }))).toBe(
      '3rd quarter, 4:32',
    );
    expect(liveSituation(liveGame({ statusDetail: null, period: 5, clock: null }))).toBe(
      'Overtime',
    );
    expect(liveSituation(liveGame({ statusDetail: '  ', period: null, clock: null }))).toBe(
      'In progress',
    );
  });
});

describe('names and initials', () => {
  it('uses the short display name, falling back to the full name', () => {
    expect(teamLabel({ displayName: 'Alabama', name: 'Alabama Crimson Tide' })).toBe('Alabama');
    expect(teamLabel({ displayName: null, name: 'Southern Miss Golden Eagles' })).toBe(
      'Southern Miss Golden Eagles',
    );
    expect(teamLabel({ displayName: '  ', name: 'Tulane Green Wave' })).toBe('Tulane Green Wave');
  });

  it('builds a logo placeholder from the abbreviation, else from the name', () => {
    expect(initials('Alabama', 'ALA')).toBe('ALA');
    expect(initials('Texas A&M', 'TA&M')).toBe('TA&M');
    expect(initials('Southern Miss', 'SOUTHERN')).toBe('SM');
    expect(initials('Wilson')).toBe('WI');
    expect(initials('Mary Kate Olsen')).toBe('MK');
    expect(initials('   ')).toBe('?');
  });
});
