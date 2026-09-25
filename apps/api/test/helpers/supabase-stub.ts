import { vi } from 'vitest';
import type { Env } from '../../src/env';

/**
 * A stand-in for Supabase: JWKS endpoint, PostgREST tables, and RPC.
 *
 * It records every request, which is what lets the tests assert the thing that
 * actually matters about `db/client.ts` — WHICH bearer token went on the wire.
 * That header is the entire difference between a query running as `anon` and one
 * running as the administrator, so it deserves a direct assertion rather than
 * being taken on trust.
 */

export const TEST_SUPABASE_URL = 'https://test-project.supabase.co';
export const TEST_ANON_KEY = 'test-anon-key';
export const TEST_ISSUER = `${TEST_SUPABASE_URL}/auth/v1`;

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: TEST_SUPABASE_URL,
    SUPABASE_ANON_KEY: TEST_ANON_KEY,
    SPORTS_PROVIDER: 'mock',
    ALLOWED_ORIGINS: '*',
    LOG_LEVEL: 'error',
    ...overrides,
  };
}

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  authorization: string | null;
  apikey: string | null;
  body: unknown;
}

export interface StubRoute {
  /** Matched against `pathname + search`. */
  match: (url: URL, method: string) => boolean;
  respond: (request: RecordedRequest) => { status: number; body: unknown };
}

export interface SupabaseStub {
  requests: RecordedRequest[];
  /** Requests to PostgREST only, in order. */
  restRequests: RecordedRequest[];
  /** Requests to ESPN only, in order. */
  espnRequests: RecordedRequest[];
  jwksFetches: number;
  restore: () => void;
}

export interface StubOptions {
  jwks?: { keys: JsonWebKey[] };
  /** Answer for `POST /rest/v1/rpc/is_admin`. A function sees the bearer token. */
  isAdmin?: boolean | ((request: RecordedRequest) => boolean);
  /** Rows returned for `GET /rest/v1/app_users`. Filtered by `id=eq.` when the query has one. */
  appUsers?: unknown[];
  /** Rows returned for `GET /rest/v1/teams`, filtered by `id=eq.`. */
  teams?: unknown[];
  /**
   * Rows returned for `GET /rest/v1/user_team_selections` — the pick index's
   * own query (plan-search-engine, Part Two, Phase 5).
   *
   * Its own option rather than a `select`-aware `appUsers`: this stub answers
   * `appUsers` for ANY `GET /rest/v1/app_users` whatever the `select` asked
   * for, so an owner-index row shape and a `/api/users` row shape would collide
   * in any test that needed both. Reading the selections table from its own end
   * keeps the two apart.
   */
  selections?: unknown[];
  /** Extra routes, checked before the built-ins. */
  routes?: StubRoute[];
  /** Force every PostgREST call to fail with this status. */
  restFailure?: number;
  /** Anything that is not Supabase (the ESPN fixture stub). `null` falls through to a 404. */
  external?: (url: URL) => Response | null;
}

/** PostgREST's `id=eq.<uuid>` filter, applied to stubbed rows. */
function filterById(rows: unknown[], url: URL): unknown[] {
  const filter = url.searchParams.get('id');
  if (filter === null || !filter.startsWith('eq.')) return rows;
  const id = filter.slice('eq.'.length);
  return rows.filter((row) => (row as { id?: unknown }).id === id);
}

export function installSupabaseStub(options: StubOptions = {}): SupabaseStub {
  const stub: SupabaseStub = {
    requests: [],
    restRequests: [],
    espnRequests: [],
    jwksFetches: 0,
    restore: () => {
      vi.unstubAllGlobals();
    },
  };

  const json = (status: number, body: unknown): Response =>
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });

  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl);
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);

      let body: unknown = null;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }

      const recorded: RecordedRequest = {
        method,
        url: rawUrl,
        path: url.pathname + url.search,
        authorization: headers.get('Authorization'),
        apikey: headers.get('apikey'),
        body,
      };
      stub.requests.push(recorded);
      if (url.pathname.startsWith('/rest/v1')) stub.restRequests.push(recorded);
      if (url.hostname.endsWith('espn.com')) stub.espnRequests.push(recorded);

      for (const route of options.routes ?? []) {
        if (route.match(url, method)) {
          const { status, body: responseBody } = route.respond(recorded);
          return json(status, responseBody);
        }
      }

      if (url.pathname === '/auth/v1/.well-known/jwks.json') {
        stub.jwksFetches += 1;
        return json(200, options.jwks ?? { keys: [] });
      }

      if (options.restFailure !== undefined && url.pathname.startsWith('/rest/v1')) {
        return json(options.restFailure, { code: 'STUB', message: 'forced failure' });
      }

      if (url.pathname === '/rest/v1/rpc/is_admin') {
        const answer =
          typeof options.isAdmin === 'function'
            ? options.isAdmin(recorded)
            : (options.isAdmin ?? false);
        return json(200, answer);
      }

      if (url.pathname === '/rest/v1/app_users') {
        if (method === 'POST') {
          const row = body as { display_name?: string } | null;
          return json(201, [
            { id: '11111111-2222-3333-4444-555555555555', display_name: row?.display_name ?? '' },
          ]);
        }
        return json(200, filterById(options.appUsers ?? [], url));
      }

      if (url.pathname === '/rest/v1/teams' && method === 'GET') {
        return json(200, filterById(options.teams ?? [], url));
      }

      if (url.pathname === '/rest/v1/user_team_selections' && method === 'GET') {
        return json(200, options.selections ?? []);
      }

      const external = options.external?.(url);
      if (external !== undefined && external !== null) return external;

      return json(404, { message: `unstubbed: ${method} ${url.pathname}` });
    },
  );

  return stub;
}

/** Nine users with six teams each — the shape `/api/users` is specified to return. */
export function nineSeededUsers(): unknown[] {
  return [
    'Avery',
    'Blake',
    'Casey',
    'Devin',
    'Emerson',
    'Finley',
    'Harper',
    'Jordan',
    'Wilson',
  ].map((displayName, index) => ({
    id: `0000000${index}-0000-4000-8000-000000000000`,
    display_name: displayName,
    user_team_selections: [{ count: 6 }],
  }));
}
