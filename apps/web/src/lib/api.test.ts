import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, publicPathsFor, PUBLIC_INDEX_PATHS, queryKeys } from './api';

/**
 * The two things about the public search that are easy to get wrong and
 * invisible once wrong: which URL it calls, and where its results are cached.
 * The pick index has exactly the same two, and the same answers.
 */

let urls: string[];
let headers: Array<Record<string, unknown>>;

beforeEach(() => {
  urls = [];
  headers = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    urls.push(url);
    headers.push(Object.fromEntries(new Headers(init.headers).entries()));
    return Promise.resolve(
      new Response(JSON.stringify({ teams: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.searchTeams', () => {
  it('calls the public route, not the admin one, and carries no token', async () => {
    await api.searchTeams('texas');
    expect(urls).toEqual(['/api/search/teams?q=texas']);
    expect(headers[0]).not.toHaveProperty('authorization');
  });

  it('encodes the query, so "texas a&m" cannot become two parameters', async () => {
    await api.searchTeams('texas a&m');
    expect(urls).toEqual(['/api/search/teams?q=texas%20a%26m']);
  });
});

describe('queryKeys.search', () => {
  it('is not under the admin prefix', () => {
    expect(queryKeys.search('texas')[0]).not.toBe('admin');
  });

  /**
   * Signing out removes every `['admin', …]` query. A viewer's search results
   * are not the administrator's, and a search box on every page would empty
   * itself the moment the admin signed out if this key sat under that prefix.
   */
  it('survives the sign-out sweep that clears the admin console’s own search', () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.search('texas'), { teams: [] });
    client.setQueryData(queryKeys.adminSearch('texas'), { teams: [] });

    client.removeQueries({ queryKey: ['admin'] });

    expect(client.getQueryData(queryKeys.search('texas'))).toEqual({ teams: [] });
    expect(client.getQueryData(queryKeys.adminSearch('texas'))).toBeUndefined();
  });

  it('gives "Texas" and "texas" one entry once normalized, not two', () => {
    const key = (raw: string) => queryKeys.search(raw.trim().toLowerCase());
    expect(key('  Texas ')).toEqual(key('texas'));
  });
});

describe('api.teamOwners', () => {
  it('reads the public index, with no token and no query of any kind', async () => {
    await api.teamOwners();
    expect(urls).toEqual(['/api/selections']);
    expect(headers[0]).not.toHaveProperty('authorization');
  });
});

describe('queryKeys.owners', () => {
  it('is one constant key, so typing another letter cannot ask for it again', () => {
    expect(queryKeys.owners).toEqual(['owners']);
  });

  it('is not under the admin prefix, and survives the sign-out sweep', () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.owners, { owners: {} });
    client.setQueryData(queryKeys.adminUsers, []);

    client.removeQueries({ queryKey: ['admin'] });

    expect(client.getQueryData(queryKeys.owners)).toEqual({ owners: {} });
    expect(client.getQueryData(queryKeys.adminUsers)).toBeUndefined();
  });
});

/**
 * An admin write makes the index stale in the administrator's OWN browser,
 * where it may be held for its five minutes. Every write re-fetches it, whether
 * or not a board was the thing that changed: a rename changes the names in it.
 */
describe('the paths an admin write re-fetches', () => {
  it('includes the pick index whatever changed', () => {
    expect(PUBLIC_INDEX_PATHS).toContain('/api/selections');
    expect(publicPathsFor('u-1')).toContain('/api/selections');
  });

  it('adds that board’s own two reads to the same list', () => {
    expect(publicPathsFor('u-1')).toEqual([
      ...PUBLIC_INDEX_PATHS,
      '/api/users/u-1',
      '/api/users/u-1/board',
    ]);
  });
});
