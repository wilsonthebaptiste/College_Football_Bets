import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_USER_AGENT, EspnClient } from '../../src/providers/espn/client';
import { ProviderError } from '../../src/providers/types';

/**
 * The HTTP posture from the Phase 1 spike (docs/espn-notes.md §1): one retry
 * for what might clear, none for what will not, and a 403 from ESPN's CDN
 * treated as throttling, never as authorization.
 */

const URL_ = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/rankings';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const html = (status: number): Response =>
  new Response('<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD></HTML>', { status });

function clientWith(...responses: (Response | Error)[]) {
  const queue = [...responses];
  const fetchMock = vi.fn(async (): Promise<Response> => {
    const next = queue.shift();
    if (next === undefined) throw new Error('fetch called more times than stubbed');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async (): Promise<void> => undefined);
  const client = new EspnClient({
    fetch: fetchMock as unknown as typeof fetch,
    sleep,
    random: () => 0.5,
  });
  return { client, fetchMock, sleep };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error('expected a ProviderError');
}

describe('EspnClient', () => {
  it('retries once after an Akamai 403, and succeeds', async () => {
    const { client, fetchMock, sleep } = clientWith(html(403), json({ ok: true }));
    await expect(client.getJson(URL_)).resolves.toEqual({ status: 200, body: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('reports a persistent 403 as provider_unavailable, not forbidden', async () => {
    const { client, fetchMock } = clientWith(html(403), html(403));
    const error = await failure(client.getJson(URL_));
    expect(error).toMatchObject({ kind: 'unavailable', retryable: true, status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a network error and a 5xx, but only once', async () => {
    const { client, fetchMock } = clientWith(new TypeError('network down'), json({}, 502));
    expect(await failure(client.getJson(URL_))).toMatchObject({ kind: 'unavailable', status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a timeout as unavailable', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    const { client } = clientWith(timeout, timeout);
    expect(await failure(client.getJson(URL_))).toMatchObject({
      kind: 'unavailable',
      retryable: true,
    });
  });

  it('does not retry a 404, and calls it not_found', async () => {
    const { client, fetchMock } = clientWith(html(404));
    expect(await failure(client.getJson(URL_))).toMatchObject({
      kind: 'not_found',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a 404 as data when asked to (the "no predictor" case)', async () => {
    const body = { error: { message: 'No event found for eventId: 1', code: 404 } };
    const { client } = clientWith(json(body, 404));
    await expect(client.getJson(URL_, { notFoundIsData: true })).resolves.toEqual({
      status: 404,
      body,
    });
  });

  it('checks the body, not just the status: 200 with an error document', async () => {
    const notFoundBody = clientWith(json({ error: { code: 404, message: 'gone' } }));
    expect(await failure(notFoundBody.client.getJson(URL_))).toMatchObject({ kind: 'not_found' });

    const badRequest = clientWith(json({ code: 400, message: 'bad' }));
    expect(await failure(badRequest.client.getJson(URL_))).toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('rejects a 200 that is not JSON, without retrying it', async () => {
    const { client, fetchMock } = clientWith(
      new Response('<html>maintenance</html>', { status: 200 }),
    );
    expect(await failure(client.getJson(URL_))).toMatchObject({ kind: 'invalid_response' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a truncated JSON body as invalid, not as a crash', async () => {
    const { client } = clientWith(
      new Response('{"events":[{"id":"1","date":"2026-', { status: 200 }),
    );
    expect(await failure(client.getJson(URL_))).toMatchObject({ kind: 'invalid_response' });
  });

  it('sends an explicit User-Agent and a timeout signal', async () => {
    const { client, fetchMock } = clientWith(json({}));
    await client.getJson(URL_);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get('User-Agent')).toMatch(/college-football-bets/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends ESPN_USER_AGENT when set, and ignores a blank or unusable one', () => {
    expect(new EspnClient({ userAgent: 'curl/8.9.1 college-football-bets/0.2' }).userAgent).toBe(
      'curl/8.9.1 college-football-bets/0.2',
    );
    expect(new EspnClient({ userAgent: '  ' }).userAgent).toBe(DEFAULT_USER_AGENT);
    expect(new EspnClient({ userAgent: 'bad\nvalue' }).userAgent).toBe(DEFAULT_USER_AGENT);
    expect(new EspnClient({ userAgent: 'é' }).userAgent).toBe(DEFAULT_USER_AGENT);
    expect(new EspnClient({ userAgent: undefined }).userAgent).toBe(DEFAULT_USER_AGENT);
  });
});
