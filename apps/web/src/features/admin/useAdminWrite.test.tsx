import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../lib/api';
import { useAfterAdminWrite } from './useAdminWrite';

/**
 * What happens after an admin write (plan §5.1, and plan-search-engine Phase
 * 6). The administrator is the one person who can be looking at a page they
 * just made stale, and their own browser may hold the public copies for the
 * whole of their `max-age` — five minutes for the people list and the pick
 * index. So each is re-fetched from the network first, and only then are the
 * viewer queries invalidated, so their refetch finds the new copy.
 */

let urls: string[];

beforeEach(() => {
  urls = [];
  vi.stubGlobal('fetch', (url: string) => {
    urls.push(String(url));
    return Promise.resolve(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The hook's callback, out of a render. It closes over the query client and
 * nothing else, so calling it afterwards is what a button press does.
 */
function afterWriteFor(client: QueryClient): (userId: string | null) => void {
  let afterWrite: ((userId: string | null) => void) | undefined;
  function Harness() {
    afterWrite = useAfterAdminWrite();
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  if (afterWrite === undefined) throw new Error('the hook never ran');
  return afterWrite;
}

function seeded(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(queryKeys.owners, { owners: {} });
  client.setQueryData(queryKeys.users, []);
  return client;
}

const invalidated = (client: QueryClient, key: readonly unknown[]): boolean =>
  client.getQueryState(key)?.isInvalidated === true;

describe('a change to one board', () => {
  it('re-fetches that board, the people list, and the pick index', async () => {
    const client = seeded();
    afterWriteFor(client)('u-1');

    await vi.waitFor(() => {
      expect(invalidated(client, queryKeys.owners)).toBe(true);
    });
    expect(urls).toEqual([
      '/api/users',
      '/api/selections',
      '/api/users/u-1',
      '/api/users/u-1/board',
    ]);
    expect(invalidated(client, queryKeys.users)).toBe(true);
  });
});

describe('a change with no board of its own — a rename, an added person', () => {
  /**
   * The index carries display names as well as memberships, so a rename goes
   * stale in it even though no board changed. Without this the administrator
   * who just renamed someone would be the one person still seeing the old name
   * beside a search result, for five minutes.
   */
  it('still re-fetches and invalidates the pick index', async () => {
    const client = seeded();
    afterWriteFor(client)(null);

    await vi.waitFor(() => {
      expect(invalidated(client, queryKeys.owners)).toBe(true);
    });
    expect(urls).toEqual(['/api/users', '/api/selections']);
  });
});
