import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  getPublic,
  kindForStatus,
  NETWORK_ERROR_MESSAGE,
  requestAdmin,
  type AdminAuthHooks,
} from './apiClient';
import { normalizeApiBase, readSupabaseConfig } from './config';
import { shouldRetry } from './queryClient';

interface Sent {
  url: string;
  init: RequestInit;
}

let sent: Sent[];

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function stubFetch(...responses: Array<Response | Error>) {
  const queue = [...responses];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
}

const authorizationOf = (request: Sent | undefined): string | null =>
  new Headers(request?.init.headers).get('Authorization');

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getPublic — viewer reads (plan §11.1)', () => {
  it('returns the parsed body and never sends a token', async () => {
    stubFetch(json(200, { users: [] }));
    await expect(getPublic('/api/users')).resolves.toEqual({ users: [] });
    expect(sent).toHaveLength(1);
    expect(authorizationOf(sent[0])).toBeNull();
    expect(sent[0]?.url).toBe('/api/users');
  });

  it('turns the API’s error body into an ApiError with its kind and request id (§38)', async () => {
    stubFetch(
      json(404, { error: { kind: 'not_found', message: 'No such user.', requestId: 'req-1' } }),
    );
    const error = await getPublic('/api/users/x').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      kind: 'not_found',
      message: 'No such user.',
      status: 404,
      requestId: 'req-1',
    });
  });

  it('classifies an error page that is not our JSON by its status', async () => {
    stubFetch(
      new Response('<html>Bad gateway</html>', {
        status: 503,
        headers: { 'X-Request-Id': 'edge-9' },
      }),
    );
    const error = await getPublic('/api/users').catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      kind: 'provider_unavailable',
      status: 503,
      requestId: 'edge-9',
    });
  });

  it('reports a dropped connection as a network error with no status', async () => {
    stubFetch(new TypeError('Failed to fetch'));
    const error = await getPublic('/api/users').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: null, message: NETWORK_ERROR_MESSAGE });
  });

  it('lets a cancelled request stay a cancellation', async () => {
    stubFetch(new DOMException('aborted', 'AbortError'));
    const error = await getPublic('/api/users').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DOMException);
  });

  it('refuses a success response that is not JSON', async () => {
    stubFetch(new Response('not json', { status: 200 }));
    await expect(getPublic('/api/users')).rejects.toMatchObject({ kind: 'internal' });
  });
});

describe('requestAdmin — the admin session', () => {
  function hooks(tokens: { current: string | null; refreshed: string | null }) {
    const calls = { refresh: 0, unauthorized: 0 };
    const auth: AdminAuthHooks = {
      getAccessToken: async () => tokens.current,
      refresh: async () => {
        calls.refresh += 1;
        return tokens.refreshed;
      },
      onUnauthorized: () => {
        calls.unauthorized += 1;
      },
    };
    return { auth, calls };
  }

  it('sends the admin’s bearer token and skips every cache', async () => {
    stubFetch(json(200, { admin: { authUserId: 'u1' } }));
    const { auth } = hooks({ current: 'token-a', refreshed: null });

    await expect(requestAdmin(auth, '/api/admin/session')).resolves.toEqual({
      admin: { authUserId: 'u1' },
    });
    expect(authorizationOf(sent[0])).toBe('Bearer token-a');
    expect(sent[0]?.init.cache).toBe('no-store');
  });

  it('on a 401, refreshes once and retries with the new token', async () => {
    stubFetch(
      json(401, { error: { kind: 'unauthorized', message: 'expired', requestId: null } }),
      json(200, { ok: true }),
    );
    const { auth, calls } = hooks({ current: 'old', refreshed: 'new' });

    await expect(requestAdmin(auth, '/api/admin/session')).resolves.toEqual({ ok: true });
    expect(calls).toEqual({ refresh: 1, unauthorized: 0 });
    expect(sent.map(authorizationOf)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('after a second 401, clears the session and reports unauthorized', async () => {
    const unauthorized = () =>
      json(401, { error: { kind: 'unauthorized', message: 'nope', requestId: 'r' } });
    stubFetch(unauthorized(), unauthorized());
    const { auth, calls } = hooks({ current: 'old', refreshed: 'also-bad' });

    await expect(requestAdmin(auth, '/api/admin/session')).rejects.toMatchObject({
      kind: 'unauthorized',
      status: 401,
    });
    expect(calls).toEqual({ refresh: 1, unauthorized: 1 });
    expect(sent).toHaveLength(2);
  });

  it('when the refresh itself fails, gives up without a second request', async () => {
    stubFetch(json(401, { error: { kind: 'unauthorized', message: 'x', requestId: null } }));
    const { auth, calls } = hooks({ current: 'old', refreshed: null });

    await expect(requestAdmin(auth, '/api/admin/session')).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    expect(calls).toEqual({ refresh: 1, unauthorized: 1 });
    expect(sent).toHaveLength(1);
  });

  it('does not treat 403 (signed in, not an admin) as a lost session', async () => {
    stubFetch(json(403, { error: { kind: 'forbidden', message: 'Admins only.', requestId: 'r' } }));
    const { auth, calls } = hooks({ current: 'token', refreshed: 'x' });

    await expect(requestAdmin(auth, '/api/admin/session')).rejects.toMatchObject({
      kind: 'forbidden',
      status: 403,
    });
    expect(calls).toEqual({ refresh: 0, unauthorized: 0 });
  });

  it('never sends a request at all without a session', async () => {
    stubFetch();
    await expect(requestAdmin(null, '/api/admin/session')).rejects.toMatchObject({
      kind: 'unauthorized',
    });

    const { auth, calls } = hooks({ current: null, refreshed: null });
    await expect(requestAdmin(auth, '/api/admin/session')).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    expect(calls.unauthorized).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it('sends a JSON body with its content type', async () => {
    stubFetch(json(201, { user: { id: '1', displayName: 'New' } }));
    const { auth } = hooks({ current: 'token', refreshed: null });

    await requestAdmin(auth, '/api/admin/users', {
      method: 'POST',
      body: { displayName: 'New' },
    });
    expect(sent[0]?.init.method).toBe('POST');
    expect(sent[0]?.init.body).toBe('{"displayName":"New"}');
    expect(new Headers(sent[0]?.init.headers).get('Content-Type')).toBe('application/json');
  });
});

describe('error classification and retries', () => {
  it('maps statuses to the §38 kinds', () => {
    expect(kindForStatus(400)).toBe('invalid_request');
    expect(kindForStatus(401)).toBe('unauthorized');
    expect(kindForStatus(403)).toBe('forbidden');
    expect(kindForStatus(404)).toBe('not_found');
    expect(kindForStatus(409)).toBe('conflict');
    expect(kindForStatus(429)).toBe('rate_limited');
    expect(kindForStatus(502)).toBe('provider_invalid_response');
    expect(kindForStatus(503)).toBe('provider_unavailable');
    expect(kindForStatus(500)).toBe('internal');
  });

  it('retries server and network failures, never a 4xx', () => {
    const error = (status: number | null) =>
      new ApiError({ kind: 'internal', message: 'x', requestId: null }, status);
    expect(shouldRetry(0, error(404))).toBe(false);
    expect(shouldRetry(0, error(401))).toBe(false);
    expect(shouldRetry(0, error(500))).toBe(true);
    expect(shouldRetry(0, error(null))).toBe(true);
    expect(shouldRetry(2, error(500))).toBe(false);
  });
});

describe('configuration', () => {
  it('strips trailing slashes from the API base', () => {
    expect(normalizeApiBase(undefined)).toBe('');
    expect(normalizeApiBase(' https://api.example.dev/ ')).toBe('https://api.example.dev');
  });

  it('accepts the Supabase URL with or without a pasted /rest/v1 suffix', () => {
    expect(readSupabaseConfig('https://abc.supabase.co/rest/v1/', 'key')).toEqual({
      url: 'https://abc.supabase.co',
      anonKey: 'key',
    });
    expect(readSupabaseConfig(' https://abc.supabase.co ', ' key ')).toEqual({
      url: 'https://abc.supabase.co',
      anonKey: 'key',
    });
  });

  it('treats missing or malformed settings as "not configured"', () => {
    expect(readSupabaseConfig(undefined, 'key')).toBeNull();
    expect(readSupabaseConfig('https://abc.supabase.co', '')).toBeNull();
    expect(readSupabaseConfig('abc.supabase.co', 'key')).toBeNull();
  });
});
