import { describe, expect, it, vi } from 'vitest';
import { PlayoffStatusClient } from '../../src/providers/playoffstatus/client';
import { POWER_FOUR, conferencePageUrl } from '../../src/providers/playoffstatus/conferences';
import {
  BELOW_ONE_PERCENT,
  decodeEntities,
  parseConferencePage,
  readComputedLabel,
  readPercent,
  readTeamName,
} from '../../src/providers/playoffstatus/parse';
import { PlayoffStatusProvider } from '../../src/providers/playoffstatus/provider';
import { ProviderError } from '../../src/providers/types';
import { CONFERENCE_FIXTURES, conferencePageFixture } from '../helpers/fixtures';

/**
 * playoffstatus.com, against the four real captured pages: the conference half
 * of projected points, and the only published source of a conference
 * RUNNER-UP probability anywhere in this feature.
 *
 * This is a scrape, so it cannot be validated the way JSON is. The guardrails
 * are the row count, the two column sums, and the two-way join, and they are
 * what these tests exercise. Everything else here is one of the three traps
 * the parse hit on the way to working.
 */

/** As captured, 2026-10-01. The membership of the four conferences, exactly. */
const EXPECTED: Readonly<
  Record<string, { rows: number; champion: number; participate: number; stamp: string }>
> = {
  SEC: { rows: 16, champion: 100.0, participate: 200.5, stamp: 'Sat Sep 26 11:30 pm' },
  'Big Ten': { rows: 18, champion: 101.0, participate: 199.5, stamp: 'Sun Sep 27 2:45 am' },
  'Big 12': { rows: 16, champion: 102.5, participate: 200.5, stamp: 'Sat Sep 26 11:30 pm' },
  ACC: { rows: 17, champion: 101.0, participate: 202.0, stamp: 'Sun Sep 27 2:45 am' },
};

/** A client that answers each conference URL from its captured page. */
function capturedClient(overrides: Readonly<Record<string, string>> = {}): PlayoffStatusClient {
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const conference = POWER_FOUR.find((name) => conferencePageUrl(name) === url);
    if (conference === undefined) return new Response('not found', { status: 404 });
    const html = overrides[conference] ?? conferencePageFixture(conference);
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
  });
  return new PlayoffStatusClient({ fetch: stub as unknown as typeof fetch });
}

describe('the three parsing traps', () => {
  it('decodes entities before anything else', () => {
    // `Texas A&amp;M` and `&lt;1%` are both in the real pages, and the page's
    // own stamp separates its words with `&#160;`.
    expect(decodeEntities('Texas A&amp;M')).toBe('Texas A&M');
    expect(decodeEntities('&lt;1%')).toBe('<1%');
    expect(decodeEntities('Sat Sep&#160;26')).toBe('Sat Sep 26');
    expect(decodeEntities('&#x26;')).toBe('&');
    // An entity nobody decodes is left alone rather than eaten.
    expect(decodeEntities('&notanentity;')).toBe('&notanentity;');
  });

  it('reads the wide spelling, not both spellings concatenated', () => {
    const cell =
      '<a href="mississippist_standings.html">' +
      '<span class="wide">Mississippi St.</span><span class="narrow">Miss. St.</span></a>';
    // Stripping tags over the whole cell yields "Mississippi St.Miss. St.",
    // which matches no team on either side of the join.
    expect(readTeamName(cell)).toBe('Mississippi St.');
  });

  it('falls back to the anchor when there is no wide span', () => {
    expect(readTeamName('<a href="texasstandings.html">Texas</a>')).toBe('Texas');
    expect(readTeamName('Plain Text')).toBe('Plain Text');
    expect(readTeamName('')).toBeNull();
  });

  it('walks rows and then cells, so no row is silently dropped', () => {
    // The trap itself: a single regex over the whole table lost one row per
    // page (SEC 15 of 16, Big Ten 17 of 18) with no other symptom. The row
    // counts below are the assertion that it is not happening again.
    for (const [conference, expected] of Object.entries(EXPECTED)) {
      const parsed = parseConferencePage(conferencePageFixture(conference), conference);
      expect(parsed.page.rows, conference).toBe(expected.rows);
      expect(parsed.droppedRows, conference).toBe(0);
    }
  });
});

describe('percentages', () => {
  it('reads <1% as a half percent', () => {
    expect(readPercent('&lt;1%')).toBe(BELOW_ONE_PERCENT);
    expect(readPercent('<span style="color:#008000;">&lt;1%</span>')).toBe(BELOW_ONE_PERCENT);
  });

  it('reads an ordinary whole percent', () => {
    expect(readPercent('<span style="color:#008000;">19%</span>')).toBe(19);
    expect(readPercent('0%')).toBe(0);
    expect(readPercent('100%')).toBe(100);
  });

  it('refuses anything that is not a published figure', () => {
    // `null` becomes a dropped row, which the caller refuses. A zero here
    // would assert "no chance" on the strength of a cell we could not read.
    for (const cell of ['', '—', 'TBD', '19', '110%', '-5%', 'garbage']) {
      expect(readPercent(cell), cell).toBeNull();
    }
  });
});

describe('the four captured pages', () => {
  it('parses to the measured rows and column sums', () => {
    for (const [conference, expected] of Object.entries(EXPECTED)) {
      const { page } = parseConferencePage(conferencePageFixture(conference), conference);
      expect(page.rows, conference).toBe(expected.rows);
      expect(page.championPercent, conference).toBeCloseTo(expected.champion, 6);
      expect(page.participatePercent, conference).toBeCloseTo(expected.participate, 6);
    }
  });

  it('keeps the publisher’s own spelling, entities and all', () => {
    const sec = parseConferencePage(conferencePageFixture('SEC'), 'SEC');
    const names = sec.rows.map((row) => row.teamName);
    expect(names).toContain('Texas A&M');
    expect(names).toContain('Mississippi St.');
    expect(names).toContain('Ole Miss');
    // No row carries a doubled spelling or a stray entity.
    for (const name of names) {
      expect(name).not.toMatch(/&[a-z]+;|&#/i);
      expect(name).not.toMatch(/\.[A-Z]/);
    }
  });

  it('carries each page’s own stamp verbatim, never parsed', () => {
    for (const [conference, expected] of Object.entries(EXPECTED)) {
      const { page } = parseConferencePage(conferencePageFixture(conference), conference);
      expect(page.computedLabel, conference).toBe(expected.stamp);
    }
  });

  it('turns percentages into probabilities, and keeps the two nested', () => {
    for (const conference of Object.keys(EXPECTED)) {
      const { rows } = parseConferencePage(conferencePageFixture(conference), conference);
      for (const row of rows) {
        expect(row.winConference).toBeGreaterThanOrEqual(0);
        expect(row.winConference).toBeLessThanOrEqual(1);
        // Winning the conference means playing in its championship game, so
        // the runner-up term `max(0, e − d)` should not need its floor on real
        // data. (It still has one: a publisher's rounding can invert them.)
        expect(row.reachConferenceGame, `${conference} ${row.teamName}`).toBeGreaterThanOrEqual(
          row.winConference,
        );
      }
    }
  });
});

describe('the page stamp', () => {
  it('collapses the non-breaking spaces it is published with', () => {
    const html = '<div class="datetime">\n\t\tSat Sep&#160;26 11:30&#160;pm\n\t</div>';
    expect(readComputedLabel(html)).toBe('Sat Sep 26 11:30 pm');
  });

  it('is null when the page carries none', () => {
    expect(readComputedLabel('<div class="other">whenever</div>')).toBeNull();
  });
});

describe('PlayoffStatusProvider', () => {
  const season = { year: 2026, type: 'regular' as const, week: 5 };

  it('returns all 67 power-four rows, with one page summary each', async () => {
    const document = await new PlayoffStatusProvider(capturedClient()).getConferenceOdds(season);

    // 16 + 18 + 16 + 17 — which is exactly the four conferences' membership in
    // the conference map captured the same day. No power-four team is missing.
    expect(document.rows).toHaveLength(67);
    expect(document.pages.map((page) => page.conference)).toEqual([...POWER_FOUR]);
    expect(document.pages.map((page) => page.rows)).toEqual(
      POWER_FOUR.map((conference) => EXPECTED[conference]?.rows),
    );
  });

  it('reports no single stamp, because the four pages do not agree on one', async () => {
    const document = await new PlayoffStatusProvider(capturedClient()).getConferenceOdds(season);

    // The plan assumed one stamp for the feature. Measured: SEC and Big 12 say
    // "Sat Sep 26 11:30 pm" and Big Ten and ACC say "Sun Sep 27 2:45 am" — the
    // pages are recomputed in batches. Nothing picks between two such strings:
    // that needs a year and a timezone the publisher does not give, and
    // inventing either to put a confident date on screen is the one thing this
    // feature may not do. So the document-level label is null and each page
    // keeps its own.
    expect(document.computedLabel).toBeNull();
    expect(new Set(document.pages.map((page) => page.computedLabel))).toEqual(
      new Set(['Sat Sep 26 11:30 pm', 'Sun Sep 27 2:45 am']),
    );
  });

  it('reports one stamp when every page does agree', async () => {
    const stamped = Object.fromEntries(
      POWER_FOUR.map((conference) => [
        conference,
        conferencePageFixture(conference).replace(
          /<div class="datetime">[\s\S]*?<\/div>/i,
          '<div class="datetime">Sat Sep&#160;26 11:30&#160;pm</div>',
        ),
      ]),
    );

    const document = await new PlayoffStatusProvider(capturedClient(stamped)).getConferenceOdds(
      season,
    );
    expect(document.computedLabel).toBe('Sat Sep 26 11:30 pm');
  });

  it('refuses a page with a row deleted', async () => {
    // The failure the column sums exist for. One SEC row removed: 16 → 15, and
    // the champions column falls from 100% to 89%.
    const mangled = conferencePageFixture('SEC').replace(
      /<tr>\s*<td class="tblteam"><a href="texasstandings\.html">Texas<\/a><\/td>[\s\S]*?<\/tr>/i,
      '',
    );
    expect(mangled).not.toContain('texasstandings.html');

    const provider = new PlayoffStatusProvider(capturedClient({ SEC: mangled }));
    await expect(provider.getConferenceOdds(season)).rejects.toThrow(/champions column/);
  });

  it('refuses a redesigned page rather than reporting no conference terms', async () => {
    // The whole table gone: a redesign, or an error page served with a 200.
    // Sixteen teams going to zero must not read as sixteen teams with no
    // chance — it has to be loud enough that somebody goes and looks.
    const provider = new PlayoffStatusProvider(
      capturedClient({ SEC: '<html><body><h1>SEC Football</h1><p>Coming soon.</p></body></html>' }),
    );
    await expect(provider.getConferenceOdds(season)).rejects.toThrow(/too few rows/);
  });

  it('refuses a page whose percentage cells no longer parse', async () => {
    const mangled = conferencePageFixture('SEC').replaceAll(
      /<span style="color:#008000;">(\d+)%<\/span>/g,
      '<span style="color:#008000;">$1 pct</span>',
    );
    const provider = new PlayoffStatusProvider(capturedClient({ SEC: mangled }));
    await expect(provider.getConferenceOdds(season)).rejects.toThrow(
      /had no readable percentages|too few rows/,
    );
  });

  it('is an invalid_response, not a retryable outage', async () => {
    const provider = new PlayoffStatusProvider(
      capturedClient({ SEC: '<html><body></body></html>' }),
    );
    // A redesign will not fix itself on a second request. The cache's answer
    // should be the last good copy marked `stale`, not a retry loop against
    // somebody's web server.
    await expect(provider.getConferenceOdds(season)).rejects.toMatchObject({
      kind: 'invalid_response',
      retryable: false,
    });
  });
});

describe('PlayoffStatusClient', () => {
  it('identifies the project in its User-Agent', () => {
    expect(new PlayoffStatusClient().userAgent).toContain('college-football-bets');
  });

  it('retries once on a throttle, then succeeds', async () => {
    let calls = 0;
    const stub = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response('slow down', { status: 429 })
        : new Response(conferencePageFixture('SEC'), { status: 200 });
    });
    const client = new PlayoffStatusClient({
      fetch: stub as unknown as typeof fetch,
      sleep: async () => undefined,
      random: () => 0,
    });

    expect(await client.getHtml('https://example.test/page.html')).toContain('tblteam');
    expect(calls).toBe(2);
  });

  it('surfaces a moved page as an invalid response, not a missing team', async () => {
    const stub = vi.fn(async () => new Response('gone', { status: 404 }));
    const client = new PlayoffStatusClient({ fetch: stub as unknown as typeof fetch });
    await expect(client.getHtml('https://example.test/page.html')).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('gives up on a network failure as a retryable outage', async () => {
    const stub = vi.fn(async () => {
      throw new Error('connection reset');
    });
    const client = new PlayoffStatusClient({
      fetch: stub as unknown as typeof fetch,
      sleep: async () => undefined,
      random: () => 0,
    });
    await expect(client.getHtml('https://example.test/page.html')).rejects.toMatchObject({
      kind: 'unavailable',
      retryable: true,
    });
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('wraps every failure as a ProviderError', async () => {
    const stub = vi.fn(async () => new Response('teapot', { status: 418 }));
    const client = new PlayoffStatusClient({ fetch: stub as unknown as typeof fetch });
    await expect(client.getHtml('https://example.test/page.html')).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe('the parse is total over damaged HTML (§40, applied to a scrape)', () => {
  /** mulberry32, as the ESPN damage test uses: a failure reproduces exactly. */
  function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const ROUNDS = 300;

  for (const conference of Object.keys(CONFERENCE_FIXTURES)) {
    it(`${conference}: truncation and tag damage never throws`, () => {
      const html = conferencePageFixture(conference);
      const seed = [...conference].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 11) >>> 0;
      const random = prng(seed);

      for (let round = 0; round < ROUNDS; round += 1) {
        // Three kinds of damage, because a redesign looks like all three: a
        // download that stopped early, a tag that moved, and a chunk removed
        // from the middle.
        const cut = Math.floor(random() * html.length);
        const variants = [
          html.slice(0, cut),
          html.slice(cut),
          html.slice(0, cut) + html.slice(cut + Math.floor(random() * 2000)),
          html.slice(0, cut).replaceAll('<td', '<th').concat(html.slice(cut)),
          html.replaceAll('tblteam', random() < 0.5 ? 'tblteams' : ''),
        ];
        for (const variant of variants) {
          expect(
            () => parseConferencePage(variant, conference),
            `${conference}, seed ${String(seed)}, round ${String(round)}, cut ${String(cut)}`,
          ).not.toThrow();
        }
      }
    });
  }

  it('survives inputs that are not a page at all', () => {
    for (const input of ['', ' ', '<table>', '<table><tr><td class="tblteam">', '\u0000', 'null']) {
      expect(() => parseConferencePage(input, 'SEC')).not.toThrow();
      const parsed = parseConferencePage(input, 'SEC');
      // Whatever it returns, it is honest about having found nothing, which is
      // what the provider's row-count floor refuses.
      expect(parsed.rows.length).toBe(0);
    }
  });
});
