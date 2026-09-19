import type { ApiErrorBody } from '@cfb/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { resetInflight } from '../src/cache/swr';
import { resetCacheTiers } from '../src/cache/tiers';
import { CRON_GAME_DAYS, CRON_HOURLY, isGameDayWindow, runWarmers } from '../src/cron/warm';
import {
  DEFAULT_READS_PER_MINUTE,
  readsPerMinute,
  resetRateLimits,
  takeToken,
} from '../src/middleware/rate-limit';
import { espnResponse } from './helpers/espn-stub';
import { FakeKv } from './helpers/kv';
import {
  installSupabaseStub,
  nineSeededUsers,
  testEnv,
  type SupabaseStub,
} from './helpers/supabase-stub';

/**
 * Plan §5.3 (the open-API abuse budget) and §5.4 (cron warmers): the two
 * pieces of the Worker that exist to keep the app inside the free tiers.
 */

let stub: SupabaseStub | undefined;

beforeEach(() => {
  resetCacheTiers();
  resetInflight();
  resetRateLimits();
});

afterEach(() => {
  stub?.restore();
  stub = undefined;
  vi.restoreAllMocks();
});

const app = createApp();

// ─── Read budget ─────────────────────────────────────────────────────────────

describe('the per-address token bucket', () => {
  it('allows a full burst, then refuses, then refills at perMinute / 60 a second', () => {
    const now = 1_000_000;
    for (let i = 0; i < 60; i += 1) expect(takeToken('a', now, 60).allowed).toBe(true);
    const refused = takeToken('a', now, 60);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 1 });

    expect(takeToken('a', now + 500, 60).allowed).toBe(false); // half a token
    expect(takeToken('a', now + 1_000, 60).allowed).toBe(true); // one whole token
    expect(takeToken('a', now + 1_000, 60).allowed).toBe(false);
  });

  it('keeps one bucket per address', () => {
    for (let i = 0; i < 5; i += 1) takeToken('a', 0, 5);
    expect(takeToken('a', 0, 5).allowed).toBe(false);
    expect(takeToken('b', 0, 5).allowed).toBe(true);
  });

  it('never refills past the burst size', () => {
    takeToken('a', 0, 10);
    for (let i = 0; i < 10; i += 1) expect(takeToken('a', 3_600_000, 10).allowed).toBe(true);
    expect(takeToken('a', 3_600_000, 10).allowed).toBe(false);
  });

  it('reads READ_RATE_LIMIT_PER_MINUTE, with off to disable and nonsense ignored', () => {
    expect(readsPerMinute(undefined)).toBe(DEFAULT_READS_PER_MINUTE);
    expect(readsPerMinute('300')).toBe(300);
    expect(readsPerMinute('off')).toBeNull();
    expect(readsPerMinute('0')).toBeNull();
    expect(readsPerMinute('lots')).toBe(DEFAULT_READS_PER_MINUTE);
    expect(readsPerMinute('-5')).toBe(DEFAULT_READS_PER_MINUTE);
  });
});

describe('public reads are rate limited per address (plan §5.3)', () => {
  const read = (address: string | null, env = testEnv({ READ_RATE_LIMIT_PER_MINUTE: '3' })) =>
    app.request(
      '/api/users',
      { headers: address === null ? {} : { 'CF-Connecting-IP': address } },
      env,
    );

  it('answers 429 with Retry-After and the standard error body once the budget is spent', async () => {
    stub = installSupabaseStub({ appUsers: nineSeededUsers() });
    for (let i = 0; i < 3; i += 1) expect((await read('203.0.113.9')).status).toBe(200);

    const refused = await read('203.0.113.9');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    const body = await refused.json<ApiErrorBody>();
    expect(body.error.kind).toBe('rate_limited');
    expect(body.error.requestId).toBe(refused.headers.get('X-Request-Id'));
    // Refused before any work: three reads reached Postgres, not four.
    expect(stub.restRequests).toHaveLength(3);
  });

  it('another address is unaffected', async () => {
    stub = installSupabaseStub({ appUsers: nineSeededUsers() });
    for (let i = 0; i < 4; i += 1) await read('203.0.113.9');
    expect((await read('198.51.100.7')).status).toBe(200);
  });

  it('a 429 still carries CORS headers, so the page can read it', async () => {
    stub = installSupabaseStub({ appUsers: nineSeededUsers() });
    const env = testEnv({
      READ_RATE_LIMIT_PER_MINUTE: '1',
      ALLOWED_ORIGINS: 'https://cfb.example',
    });
    const ask = () =>
      app.request(
        '/api/users',
        { headers: { 'CF-Connecting-IP': '203.0.113.9', Origin: 'https://cfb.example' } },
        env,
      );
    await ask();
    const refused = await ask();
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Access-Control-Allow-Origin')).toBe('https://cfb.example');
  });

  it('is off without an address to key on, or when disabled', async () => {
    stub = installSupabaseStub({ appUsers: nineSeededUsers() });
    for (let i = 0; i < 5; i += 1) expect((await read(null)).status).toBe(200);
    const off = testEnv({ READ_RATE_LIMIT_PER_MINUTE: 'off' });
    for (let i = 0; i < 5; i += 1) expect((await read('203.0.113.9', off)).status).toBe(200);
  });

  it('does not apply to admin routes, which need a token anyway', async () => {
    stub = installSupabaseStub({ appUsers: nineSeededUsers() });
    const env = testEnv({ READ_RATE_LIMIT_PER_MINUTE: '1' });
    for (let i = 0; i < 3; i += 1) {
      const response = await app.request(
        '/api/admin/session',
        { headers: { 'CF-Connecting-IP': '203.0.113.9' } },
        env,
      );
      expect(response.status).toBe(401);
    }
  });
});

describe('every public read route sets Cache-Control (plan §5.3)', () => {
  it.each([
    '/api/health',
    '/api/meta/season',
    '/api/users',
    '/api/users/00000000-0000-4000-8000-000000009001',
  ])('%s', async (path) => {
    stub = installSupabaseStub({
      appUsers: [
        {
          id: '00000000-0000-4000-8000-000000009001',
          display_name: 'Wilson',
          user_team_selections: [],
        },
      ],
    });
    const response = await app.request(path, {}, testEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toMatch(/^(public, max-age=\d+|no-store)$/);
  });
});

// ─── Cron warmers ────────────────────────────────────────────────────────────

describe('the cron schedule (plan §5.4)', () => {
  it('game days are Friday to Sunday, August to January, in UTC', () => {
    expect(isGameDayWindow(new Date('2026-09-19T18:00:00Z'))).toBe(true); // Saturday
    expect(isGameDayWindow(new Date('2026-09-20T03:00:00Z'))).toBe(true); // Saturday night, US
    expect(isGameDayWindow(new Date('2026-09-18T23:30:00Z'))).toBe(true); // Friday night
    expect(isGameDayWindow(new Date('2027-01-10T20:00:00Z'))).toBe(true); // a January Sunday
    expect(isGameDayWindow(new Date('2026-09-16T18:00:00Z'))).toBe(false); // Wednesday
    expect(isGameDayWindow(new Date('2026-06-13T18:00:00Z'))).toBe(false); // a June Saturday
  });

  it('wrangler.toml declares exactly the two schedules the handler knows', async () => {
    const { readFile } = await import('node:fs/promises');
    const toml = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
    // Once for local runs, once under [env.production].
    const blocks = [...toml.matchAll(/^crons\s*=\s*\[([^\]]*)\]/gm)].map((match) => match[1] ?? '');
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      const declared = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
      expect(declared.sort()).toEqual([CRON_GAME_DAYS, CRON_HOURLY].sort());
    }
  });
});

describe('runWarmers', () => {
  const SATURDAY = Date.parse('2026-09-19T18:00:00Z');
  const WEDNESDAY = Date.parse('2026-09-16T18:00:00Z');

  it('warms the calendar, rankings, team list, and conferences, and touches Postgres', async () => {
    stub = installSupabaseStub({ appUsers: nineSeededUsers() });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const kv = new FakeKv();

    const report = await runWarmers(testEnv({ SPORTS_KV: kv.asNamespace() }), {
      cron: CRON_HOURLY,
      scheduledTime: WEDNESDAY,
      defer: null,
    });

    expect(report.skipped).toBe(false);
    expect(Object.fromEntries(Object.entries(report.results).map(([k, v]) => [k, v.ok]))).toEqual({
      season: true,
      rankings: true,
      teams: true,
      conferences: true,
      database: true,
    });
    expect(report.results['database']?.detail).toBe('9 users');
    // The durable copies land in KV, which is the point: other isolates read them there.
    const categories = kv.writes.map((write) => write.key.split('|')[2]).sort();
    expect(categories).toEqual(['conferences', 'rankings', 'season_calendar', 'team_list']);
    // Postgres was asked as anon, with no token.
    expect(stub.restRequests[0]?.authorization).toBeNull();
  });

  it('a second run inside the TTLs writes nothing more to KV', async () => {
    stub = installSupabaseStub({ appUsers: nineSeededUsers() });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const kv = new FakeKv();
    const env = testEnv({ SPORTS_KV: kv.asNamespace() });

    await runWarmers(env, { cron: CRON_GAME_DAYS, scheduledTime: SATURDAY, defer: null });
    const after = kv.writes.length;
    await runWarmers(env, { cron: CRON_GAME_DAYS, scheduledTime: SATURDAY + 600_000, defer: null });
    expect(kv.writes).toHaveLength(after);
  });

  it('skips the hourly run when the game-day schedule is firing too', async () => {
    stub = installSupabaseStub({ appUsers: nineSeededUsers() });
    const report = await runWarmers(testEnv(), {
      cron: CRON_HOURLY,
      scheduledTime: SATURDAY,
      defer: null,
    });
    expect(report).toEqual({ cron: CRON_HOURLY, skipped: true, results: {} });
    expect(stub.requests).toHaveLength(0);
  });

  it('reports each failure on its own and never throws', async () => {
    stub = installSupabaseStub({ restFailure: 500 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const report = await runWarmers(testEnv({ SPORTS_PROVIDER_FAULT: 'rankings' }), {
      cron: CRON_HOURLY,
      scheduledTime: WEDNESDAY,
      defer: null,
    });
    expect(report.results['rankings']?.ok).toBe(false);
    expect(report.results['database']?.ok).toBe(false);
    expect(report.results['teams']?.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('works against the ESPN adapter too', async () => {
    stub = installSupabaseStub({
      appUsers: nineSeededUsers(),
      external: (url) => espnResponse(url),
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const report = await runWarmers(testEnv({ SPORTS_PROVIDER: 'espn' }), {
      cron: CRON_HOURLY,
      scheduledTime: WEDNESDAY,
      defer: null,
    });
    expect(Object.values(report.results).every((result) => result.ok)).toBe(true);
    expect(report.results['conferences']?.detail).toBe('16 teams mapped');
  });
});
