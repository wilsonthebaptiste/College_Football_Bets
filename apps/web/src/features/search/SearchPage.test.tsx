import type { TeamSearchResponse } from '@cfb/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { readFromState } from '../../components/BackLink';
import { queryKeys } from '../../lib/api';
import { ApiError } from '../../lib/apiClient';
import {
  envelope,
  fcsIdentity,
  makeIdentity,
  makeSnapshot,
  scheduleResponse,
  searchResponse,
  teamDetail,
} from '../../test/fixtures';
import { RAW_VALUE, renderAt, spokenText, visibleText } from '../../test/render';
import { TeamPage } from '../team/TeamPage';
import { SearchPage, searchFrom } from './SearchPage';

/**
 * Phase 3's exit criteria for `/search`. Each test seeds the query cache with
 * exactly what `/api/search/teams` would have returned for the query in the
 * URL — or with the failure it would have raised — and renders the page at
 * that URL, as a viewer arriving from a shared link would.
 *
 * The debounce is not in the way: `useDebouncedValue` starts settled, so a
 * page opened at `?q=texas` reads the cache for "texas" on its first render.
 */

const TEXAS = makeIdentity({
  provider: 'espn',
  providerTeamId: '251',
  name: 'Texas Longhorns',
  displayName: 'Texas',
  abbreviation: 'TEX',
  conference: 'SEC',
});
const TEXAS_TECH = makeIdentity({
  provider: 'espn',
  providerTeamId: '2641',
  name: 'Texas Tech Red Raiders',
  displayName: 'Texas Tech',
  abbreviation: 'TTU',
  conference: 'Big 12',
});

type Seed = TeamSearchResponse | ApiError | undefined;

function seedError(client: QueryClient, queryKey: readonly unknown[], error: ApiError): void {
  client
    .getQueryCache()
    .build(client, { queryKey })
    .setState({ status: 'error', error, errorUpdatedAt: Date.now(), fetchStatus: 'idle' });
}

/** Renders `/search?q=<raw>` with `answer` already in the cache for that query. */
function renderSearch(raw: string, answer: Seed = undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const key = queryKeys.search(raw.trim().toLowerCase());
  if (answer instanceof ApiError) seedError(client, key, answer);
  else if (answer !== undefined) client.setQueryData(key, answer);

  const markup = renderAt(
    `/search?q=${encodeURIComponent(raw)}`,
    '/search',
    <SearchPage />,
    client,
  );
  return { markup, seen: visibleText(markup), heard: spokenText(markup) };
}

function headings(markup: string): string[] {
  return [...markup.matchAll(/<(h[1-3])[^>]*>(.*?)<\/\1>/g)].map(
    ([, level, inner]) => `${level ?? ''}:${visibleText(inner ?? '')}`,
  );
}

function links(markup: string): string[] {
  return [...markup.matchAll(/<a[^>]*href="([^"]*)"/g)].map(([, href]) => href ?? '');
}

describe('exit 1 — two characters or more lists matches, from a shared URL', () => {
  const { markup, seen } = renderSearch('texas', searchResponse([TEXAS, TEXAS_TECH]));

  it('seeds the input from ?q= so the URL can be shared and reloaded', () => {
    expect(markup).toContain('value="texas"');
    expect(markup).toContain('type="search"');
  });

  it('lists the matches as a plain list, never a combobox', () => {
    expect(markup).toContain('aria-label="Search results"');
    expect(markup).not.toContain('role="combobox"');
    expect(markup).not.toContain('aria-autocomplete');
    expect(markup).not.toContain('aria-activedescendant');
    expect(seen).toContain('Texas Longhorns');
    expect(seen).toContain('Texas Tech Red Raiders');
  });

  it('counts what it found, in a region that was there before the results were', () => {
    expect(markup).toContain('role="status"');
    expect(seen).toContain('2 teams found.');
  });

  it('shows each team’s conference and abbreviation', () => {
    expect(seen).toContain('SEC · TEX');
    expect(seen).toContain('Big 12 · TTU');
  });

  it('has exactly one h1, and a distinctly labelled search landmark', () => {
    expect(headings(markup)).toEqual(['h1:Search teams']);
    expect(markup).toContain('role="search"');
    expect(markup).toContain('aria-label="Team search"');
  });

  it('never renders a raw value', () => {
    expect(seen).not.toMatch(RAW_VALUE);
    expect(spokenText(markup)).not.toMatch(RAW_VALUE);
  });
});

describe('exit 2 — a result opens that team’s page, and "Search" comes back', () => {
  const { markup } = renderSearch('texas', searchResponse([TEXAS, TEXAS_TECH]));

  it('links by the PROVIDER id, the address a team with no row of ours has', () => {
    expect(links(markup)).toEqual(['/teams/251', '/teams/2641']);
  });

  it('makes the whole row one link, with the logo out of its name', () => {
    // Two results, two links: the name is not a second link inside the row.
    expect(markup.match(/<a /g)).toHaveLength(2);
    expect(markup).toContain('alt=""');
    expect(markup).not.toContain('Texas Longhorns logo');
  });

  it('carries a "from" the team page will accept, with the query intact', () => {
    // Router state never reaches the markup, so this is checked where it is
    // consumed: `readFromState` is the team page's own reader, and it refuses
    // anything that is not an in-app path.
    expect(readFromState(searchFrom('texas'))).toEqual({
      path: '/search?q=texas',
      label: 'Search',
    });
  });

  it('encodes the query rather than pasting it into a URL', () => {
    expect(readFromState(searchFrom('texas a&m'))?.path).toBe('/search?q=texas%20a%26m');
  });
});

describe('exit 2b — the team page a result opens says "Search", and comes back', () => {
  const mercer = fcsIdentity();
  const detail = teamDetail(
    { ...mercer, id: null },
    envelope(
      makeSnapshot({ ...mercer, id: null }, { ranking: { kind: 'unranked' }, liveGame: null }),
    ),
  );

  function renderTeamFromSearch() {
    const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
    client.setQueryData(queryKeys.team(mercer.providerTeamId), detail);
    client.setQueryData(
      queryKeys.schedule(mercer.providerTeamId),
      scheduleResponse({ ...mercer, id: null }),
    );
    return renderAt(
      `/teams/${mercer.providerTeamId}`,
      '/teams/:teamId',
      <TeamPage />,
      client,
      searchFrom('mercer'),
    );
  }

  it('labels the back link "Search" and points it at the results', () => {
    const markup = renderTeamFromSearch();
    expect(visibleText(markup)).toContain('Search');
    expect(links(markup)).toContain('/search?q=mercer');
  });

  it('shows what a board team shows, for a team with no row of ours', () => {
    const markup = renderTeamFromSearch();
    const seen = visibleText(markup);
    const heard = spokenText(markup);
    expect(seen).toContain('Mercer');
    // §7, the distinction that carries the weight: the poll was read and does
    // not list them ("NR"), which is NOT a failed lookup ("—").
    expect(seen).toContain('NR');
    expect(heard).toContain('Not ranked');
    expect(heard).not.toContain('Ranking unavailable');
    expect(seen).toContain('4-0');
    expect(seen).toContain('Previous game vs LSU W 31–24');
    expect(seen).toContain('Next game @ Tennessee');
    expect(seen).toContain('2026 schedule');
    expect(seen).not.toMatch(RAW_VALUE);
  });
});

describe('exit 3 — an FCS team: "Conference unknown", and nothing invented (§4, §46)', () => {
  const { markup, seen } = renderSearch('mercer', searchResponse([fcsIdentity()]));

  it('says the conference is unknown rather than guessing one', () => {
    expect(seen).toContain('Mercer Bears');
    expect(seen).toContain('Conference unknown · MER');
    expect(seen).toContain('1 team found.');
  });

  it('falls back to initials for the 12% of teams the provider gives no logo', () => {
    expect(markup).not.toContain('<img');
    expect(seen).toContain('MER');
  });
});

describe('exit 4 — every other state renders, with no raw values', () => {
  it('below the minimum: the hint shows and no request is made', () => {
    const { markup, seen } = renderSearch('a');
    expect(seen).toContain('Type at least 2 letters');
    expect(markup).toContain('value="a"');
    // Nothing claimed about results, and no empty list rendered.
    expect(seen).not.toContain('Searching…');
    expect(seen).not.toContain('No teams match');
    expect(markup).not.toContain('aria-label="Search results"');
    expect(seen).not.toMatch(RAW_VALUE);
  });

  it('with no ?q= at all: the page is the hint and an empty box', () => {
    const client = new QueryClient();
    const markup = renderAt('/search', '/search', <SearchPage />, client);
    expect(headings(markup)).toEqual(['h1:Search teams']);
    expect(markup).toContain('value=""');
    expect(visibleText(markup)).not.toMatch(RAW_VALUE);
  });

  it('while the answer is on its way: "Searching…", not a blank page', () => {
    const { seen, heard } = renderSearch('texas');
    expect(heard).toContain('Searching…');
    expect(seen).not.toContain('No teams match');
    expect(seen).not.toMatch(RAW_VALUE);
  });

  it('no matches: says so, quoting what was searched', () => {
    const { markup, seen } = renderSearch('zzzzqq', searchResponse([]));
    expect(seen).toContain('No teams match “zzzzqq”.');
    expect(markup).not.toContain('aria-label="Search results"');
    expect(seen).not.toContain('0 teams');
    expect(seen).not.toMatch(RAW_VALUE);
  });

  it('a provider outage: the message and its reference number, as an alert', () => {
    const { markup, seen } = renderSearch(
      'texas',
      new ApiError(
        {
          kind: 'provider_unavailable',
          message: 'Team information is temporarily unavailable.',
          requestId: 'req-42',
        },
        503,
      ),
    );
    expect(markup).toContain('role="alert"');
    expect(seen).toContain('Team information is temporarily unavailable.');
    expect(seen).toContain('Reference: req-42');
    // The status line stands down: the alert is the one place it is said.
    expect(seen).not.toContain('No teams match');
    expect(seen).not.toContain('Searching…');
    expect(seen).not.toMatch(RAW_VALUE);
  });

  it('a 429: the rate-limit message, not a generic failure', () => {
    const { seen } = renderSearch(
      'texas',
      new ApiError(
        {
          kind: 'rate_limited',
          message: 'Too many requests. Wait a moment and try again.',
          requestId: 'req-7',
        },
        429,
      ),
    );
    expect(seen).toContain('Too many requests. Wait a moment and try again.');
    expect(seen).toContain('Reference: req-7');
    expect(seen).not.toMatch(RAW_VALUE);
  });

  it('a failure with no reference number says nothing about one', () => {
    const { seen } = renderSearch(
      'texas',
      new ApiError(
        { kind: 'internal', message: 'Could not reach the server.', requestId: null },
        null,
      ),
    );
    expect(seen).toContain('Could not reach the server.');
    expect(seen).not.toContain('Reference:');
    expect(seen).not.toMatch(RAW_VALUE);
  });
});

describe('the input is reachable, and does not steal focus (§48)', () => {
  const { markup } = renderSearch('texas', searchResponse([TEXAS]));

  it('never autofocuses: RootLayout focuses <main> after every navigation', () => {
    expect(markup).not.toContain('autofocus');
    expect(markup).not.toContain('autoFocus');
  });

  it('is the first focusable element on the page', () => {
    const focusable = markup.match(/<(input|a|button|select|textarea)\b/g) ?? [];
    expect(focusable[0]).toBe('<input');
  });

  it('is labelled, described by the hint, and spell-check free', () => {
    const describedBy = /aria-describedby="([^"]+)"/.exec(markup)?.[1];
    expect(describedBy).toBeTruthy();
    expect(markup).toContain(`id="${describedBy ?? ''}"`);
    expect(visibleText(markup)).toContain('Find a team');
    // HTML attribute names are case-insensitive, and React's static renderer
    // keeps the JSX spelling; a browser reads either as the same attribute.
    expect(markup).toMatch(/spellcheck="false"/i);
    expect(markup).toMatch(/autocomplete="off"/i);
  });
});
