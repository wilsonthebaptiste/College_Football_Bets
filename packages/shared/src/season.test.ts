import { describe, expect, it, vi } from 'vitest';
import {
  formatSeasonLabel,
  isSameSeason,
  parseSeasonOverride,
  resolveCurrentSeason,
  resolveSeasonFromDate,
  seasonKey,
  type Season,
} from './season';

/**
 * Year literals are legal in this file (see `scripts/check-season-literals.mjs`)
 * precisely because this is where the heuristic is pinned down.
 */

const utc = (iso: string): Date => new Date(iso);

describe('resolveSeasonFromDate', () => {
  it('maps a January bowl game to the PRIOR calendar year', () => {
    // The 2025 season's playoff is played in January 2026.
    expect(resolveSeasonFromDate(utc('2026-01-09T01:00:00Z'))).toEqual({
      year: 2025,
      type: 'postseason',
      week: null,
    });
  });

  it('maps late August to the NEW season, regular play', () => {
    expect(resolveSeasonFromDate(utc('2025-08-30T18:00:00Z'))).toEqual({
      year: 2025,
      type: 'regular',
      week: null,
    });
  });

  it('treats July and early August as preseason of the upcoming year', () => {
    expect(resolveSeasonFromDate(utc('2025-07-04T12:00:00Z'))).toEqual({
      year: 2025,
      type: 'preseason',
      week: null,
    });
    expect(resolveSeasonFromDate(utc('2025-08-01T12:00:00Z'))).toEqual({
      year: 2025,
      type: 'preseason',
      week: null,
    });
  });

  it('switches from preseason to regular on August 21', () => {
    expect(resolveSeasonFromDate(utc('2025-08-20T23:59:59Z')).type).toBe('preseason');
    expect(resolveSeasonFromDate(utc('2025-08-21T00:00:00Z')).type).toBe('regular');
  });

  it('keeps October in the regular season', () => {
    expect(resolveSeasonFromDate(utc('2025-10-01T19:42:00Z'))).toEqual({
      year: 2025,
      type: 'regular',
      week: null,
    });
  });

  it('treats December as postseason of the current season year', () => {
    expect(resolveSeasonFromDate(utc('2025-12-20T20:00:00Z'))).toEqual({
      year: 2025,
      type: 'postseason',
      week: null,
    });
  });

  it('survives the dead months without inventing a season (§22)', () => {
    // No games anywhere near here. The answer must still be well-formed.
    expect(resolveSeasonFromDate(utc('2026-05-15T12:00:00Z'))).toEqual({
      year: 2025,
      type: 'postseason',
      week: null,
    });
  });

  it('handles a leap day', () => {
    expect(resolveSeasonFromDate(utc('2024-02-29T12:00:00Z'))).toEqual({
      year: 2023,
      type: 'postseason',
      week: null,
    });
  });

  it('never reports a week from the date alone', () => {
    const samples = ['2025-09-15T00:00:00Z', '2026-01-01T00:00:00Z', '2025-07-01T00:00:00Z'];
    for (const iso of samples) {
      expect(resolveSeasonFromDate(utc(iso)).week).toBeNull();
    }
  });
});

describe('parseSeasonOverride', () => {
  it('accepts a bare year and defaults to the regular season', () => {
    expect(parseSeasonOverride('2024')).toEqual({ year: 2024, type: 'regular', week: null });
  });

  it('accepts year:type and year:type:week', () => {
    expect(parseSeasonOverride('2024:postseason')).toEqual({
      year: 2024,
      type: 'postseason',
      week: null,
    });
    expect(parseSeasonOverride('2024:regular:7')).toEqual({
      year: 2024,
      type: 'regular',
      week: 7,
    });
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(parseSeasonOverride('  2024:REGULAR  ')).toEqual({
      year: 2024,
      type: 'regular',
      week: null,
    });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['nope', 'not a year'],
    ['24', 'two digits'],
    ['20245', 'five digits'],
    ['2024:bowl', 'unknown type'],
    ['2024:regular:0', 'week below 1'],
    ['2024:regular:x', 'non-numeric week'],
    ['2024:regular:1:extra', 'too many parts'],
  ])('rejects %j (%s) rather than throwing', (input) => {
    expect(parseSeasonOverride(input)).toBeNull();
  });

  it('rejects null and undefined', () => {
    expect(parseSeasonOverride(null)).toBeNull();
    expect(parseSeasonOverride(undefined)).toBeNull();
  });
});

describe('resolveCurrentSeason precedence', () => {
  const providerSeason: Season = { year: 2025, type: 'regular', week: 5 };

  it('prefers the override over everything', async () => {
    const fetchProviderSeason = vi.fn(async () => providerSeason);
    const result = await resolveCurrentSeason({
      now: utc('2025-10-01T00:00:00Z'),
      override: '2019:postseason',
      fetchProviderSeason,
    });

    expect(result).toEqual({
      season: { year: 2019, type: 'postseason', week: null },
      source: 'override',
    });
    expect(fetchProviderSeason).not.toHaveBeenCalled();
  });

  it('prefers the provider calendar over the date heuristic, because it knows the week', async () => {
    const result = await resolveCurrentSeason({
      now: utc('2025-10-01T00:00:00Z'),
      override: null,
      fetchProviderSeason: async () => providerSeason,
    });

    expect(result).toEqual({ season: providerSeason, source: 'provider' });
    expect(result.season.week).toBe(5);
  });

  it('falls back to the date heuristic when the provider has no opinion', async () => {
    const result = await resolveCurrentSeason({
      now: utc('2025-10-01T00:00:00Z'),
      fetchProviderSeason: async () => null,
    });

    expect(result).toEqual({ season: { year: 2025, type: 'regular', week: null }, source: 'date' });
  });

  it('falls back to the date heuristic when the provider THROWS (§50)', async () => {
    const result = await resolveCurrentSeason({
      now: utc('2026-01-09T01:00:00Z'),
      fetchProviderSeason: async () => {
        throw new Error('ESPN is down');
      },
    });

    expect(result).toEqual({
      season: { year: 2025, type: 'postseason', week: null },
      source: 'date',
    });
  });

  it('ignores a provider answer with an implausible year', async () => {
    const result = await resolveCurrentSeason({
      now: utc('2025-10-01T00:00:00Z'),
      fetchProviderSeason: async () => ({ year: 7, type: 'regular', week: 1 }),
    });

    expect(result.source).toBe('date');
  });

  it('ignores a malformed override rather than failing', async () => {
    const result = await resolveCurrentSeason({
      now: utc('2025-10-01T00:00:00Z'),
      override: 'garbage',
    });

    expect(result.source).toBe('date');
    expect(result.season.year).toBe(2025);
  });
});

describe('season helpers', () => {
  it('builds a cache key that ignores the week', () => {
    expect(seasonKey({ year: 2025, type: 'regular', week: 5 })).toBe('2025:regular');
    expect(seasonKey({ year: 2025, type: 'regular', week: 6 })).toBe('2025:regular');
  });

  it('compares seasons by year and type only', () => {
    expect(
      isSameSeason(
        { year: 2025, type: 'regular', week: 1 },
        { year: 2025, type: 'regular', week: 9 },
      ),
    ).toBe(true);
    expect(
      isSameSeason(
        { year: 2025, type: 'regular', week: 1 },
        { year: 2025, type: 'postseason', week: 1 },
      ),
    ).toBe(false);
  });

  it('formats a human label, with the week only when known', () => {
    expect(formatSeasonLabel({ year: 2025, type: 'regular', week: 5 })).toBe(
      '2025 regular · Week 5',
    );
    expect(formatSeasonLabel({ year: 2025, type: 'regular', week: null })).toBe('2025 regular');
  });
});
