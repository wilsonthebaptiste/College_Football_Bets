import type {
  AdminSessionResponse,
  ApiErrorBody,
  CreateUserResponse,
  HealthResponse,
  SeasonMetaResponse,
  UsersResponse,
} from '@cfb/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetJwksCache } from '../src/auth/jwks';
import { createApp } from '../src/app';
import { resetInflight } from '../src/cache/swr';
import { resetCacheTiers } from '../src/cache/tiers';
import type { Env } from '../src/env';
import {
  installSupabaseStub,
  nineSeededUsers,
  TEST_ISSUER,
  testEnv,
  type SupabaseStub,
} from './helpers/supabase-stub';
import {
  forgeAlgNoneToken,
  generateSigningKey,
  nowSeconds,
  signToken,
  type SigningKeyPair,
} from './helpers/tokens';

let signingKey: SigningKeyPair;
let stub: SupabaseStub;

beforeAll(async () => {
  signingKey = await generateSigningKey('ES256', 'test-key');
});

beforeEach(() => {
  // The JWKS memo and the cache tiers are module scope and would otherwise
  // leak between tests.
  resetJwksCache();
  resetCacheTiers();
  resetInflight();
});

afterEach(() => {
  stub.restore();
});

const app = createApp();

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = testEnv(),
): Promise<Response> {
  return await app.request(path, init, env);
}

const userToken = (claims: Record<string, unknown> = {}): Promise<string> =>
  signToken(signingKey, {
    sub: 'auth-user-1',
    iss: TEST_ISSUER,
    aud: 'authenticated',
    iat: nowSeconds() - 10,
    exp: nowSeconds() + 3600,
    ...claims,
  });

// ─── Public read routes ──────────────────────────────────────────────────────

describe('public routes require no token at all (plan §11.1)', () => {
  beforeEach(() => {
    stub = installSupabaseStub({ appUsers: nineSeededUsers() });
  });

  it('GET /api/health returns a resolved season', async () => {
    const response = await request('/api/health');
    expect(response.status).toBe(200);

    const body = await response.json<HealthResponse>();
    expect(body.status).toBe('ok');
    expect(body.provider).toBe('mock');
    expect(typeof body.season.year).toBe('number');
    expect(['preseason', 'regular', 'postseason']).toContain(body.season.type);
    expect(['override', 'provider', 'date']).toContain(body.seasonSource);
  });

  it('GET /api/health never caches — it is what you check when caching is suspect', async () => {
    const response = await request('/api/health');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('GET /api/health touches neither Postgres nor the provider', async () => {
    await request('/api/health');
    expect(stub.requests).toHaveLength(0);
  });

  it('honours SEASON_OVERRIDE', async () => {
    const response = await request(
      '/api/health',
      {},
      testEnv({ SEASON_OVERRIDE: '2019:postseason' }),
    );
    const body = await response.json<HealthResponse>();

    expect(body.season).toEqual({ year: 2019, type: 'postseason', week: null });
    expect(body.seasonSource).toBe('override');
  });

  it('ignores a malformed SEASON_OVERRIDE instead of failing', async () => {
    const response = await request('/api/health', {}, testEnv({ SEASON_OVERRIDE: 'nonsense' }));
    expect(response.status).toBe(200);
    expect((await response.json<HealthResponse>()).seasonSource).toBe('date');
  });

  it('GET /api/meta/season wraps the season in a freshness envelope', async () => {
    const response = await request('/api/meta/season');
    expect(response.status).toBe(200);

    const body = await response.json<SeasonMetaResponse>();
    expect(body.season.data).not.toBeNull();
    expect(body.season.error).toBeNull();
    expect(body.season.freshness.state).toBe('fresh');
    expect(body.season.freshness.fetchedAt).not.toBeNull();
  });

  it('GET /api/users returns nine users with no token', async () => {
    const response = await request('/api/users');
    expect(response.status).toBe(200);

    const body = await response.json<UsersResponse>();
    expect(body.users).toHaveLength(9);
    expect(body.users[0]).toEqual({
      id: expect.any(String) as string,
      displayName: 'Avery',
      teamCount: 6,
    });
  });

  it('GET /api/users queries Postgres as `anon`: anon key as apikey, no user token', async () => {
    await request('/api/users');

    const [query] = stub.restRequests;
    expect(query).toBeDefined();
    // This is the assertion that proves the read path runs as `anon`: PostgREST
    // derives the role from the Authorization header, and with none present it
    // falls back to its anonymous role.
    expect(query?.authorization).toBeNull();
    expect(query?.apikey).toBe('test-anon-key');
    expect(decodeURIComponent(query?.path ?? '')).toContain('user_team_selections(count)');
  });

  it('sets a cacheable Cache-Control on reads, so repeat traffic never reaches the Worker', async () => {
    const response = await request('/api/users');
    expect(response.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+$/);
  });

  it('puts X-Request-Id on every response', async () => {
    const response = await request('/api/users');
    expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('echoes a well-formed client-supplied request id', async () => {
    const response = await request('/api/users', { headers: { 'X-Request-Id': 'trace-abc_1' } });
    expect(response.headers.get('X-Request-Id')).toBe('trace-abc_1');
  });

  it('replaces a hostile request id rather than reflecting it', async () => {
    const response = await request('/api/users', {
      headers: { 'X-Request-Id': '<script>alert(1)</script>' },
    });
    expect(response.headers.get('X-Request-Id')).not.toContain('<script>');
  });

  it('rejects a non-uuid user id as a clean 404, without querying Postgres', async () => {
    const response = await request('/api/users/not-a-uuid');
    expect(response.status).toBe(404);
    expect((await response.json<ApiErrorBody>()).error.kind).toBe('not_found');
    expect(stub.restRequests).toHaveLength(0);
  });

  it('returns 404 for an unknown route with the standard error body', async () => {
    const response = await request('/api/nope');
    expect(response.status).toBe(404);

    const body = await response.json<ApiErrorBody>();
    expect(body.error.kind).toBe('not_found');
    expect(body.error.requestId).toBe(response.headers.get('X-Request-Id'));
  });
});

describe('database failures surface as errors, not crashes', () => {
  beforeEach(() => {
    stub = installSupabaseStub({ restFailure: 500 });
  });

  it('maps a PostgREST 500 to a 500 with an AppError body and no internal detail', async () => {
    const response = await request('/api/users');
    expect(response.status).toBe(500);

    const body = await response.json<ApiErrorBody>();
    expect(body.error.kind).toBe('internal');
    expect(body.error.message).not.toContain('supabase');
    expect(body.error.requestId).not.toBeNull();
  });

  it('says plainly that the database is not configured when .dev.vars is missing', async () => {
    const unconfigured = testEnv({ SUPABASE_URL: '', SUPABASE_ANON_KEY: '' });
    const response = await request('/api/users', {}, unconfigured);

    expect(response.status).toBe(500);
    expect((await response.json<ApiErrorBody>()).error.message).toBe(
      'The application database is not configured.',
    );
    // Failed before any network call was attempted.
    expect(stub.requests).toHaveLength(0);
  });

  it('still answers a malformed user id with 404 when the database is not configured', async () => {
    // Regression: the id used to be validated only after the database client
    // was built, so an unconfigured Worker answered a bad id with a 500.
    const unconfigured = testEnv({ SUPABASE_URL: '', SUPABASE_ANON_KEY: '' });
    const response = await request('/api/users/not-a-uuid', {}, unconfigured);

    expect(response.status).toBe(404);
  });
});

// ─── Admin routes ────────────────────────────────────────────────────────────

describe('POST /api/admin/users — the authorization boundary', () => {
  const createBody = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'New Person' }),
  };

  it('401 with no token', async () => {
    stub = installSupabaseStub({ jwks: { keys: [signingKey.jwk] } });

    const response = await request('/api/admin/users', createBody);
    expect(response.status).toBe(401);
    expect((await response.json<ApiErrorBody>()).error.kind).toBe('unauthorized');
    // Never reached the database.
    expect(stub.restRequests).toHaveLength(0);
  });

  it('401 with a malformed Authorization header', async () => {
    stub = installSupabaseStub({ jwks: { keys: [signingKey.jwk] } });

    const response = await request('/api/admin/users', {
      ...createBody,
      headers: { ...createBody.headers, Authorization: 'Basic abc123' },
    });
    expect(response.status).toBe(401);
  });

  it('401 for an alg:none forgery', async () => {
    stub = installSupabaseStub({ jwks: { keys: [signingKey.jwk] }, isAdmin: true });

    const forged = forgeAlgNoneToken({
      sub: 'attacker',
      iss: TEST_ISSUER,
      aud: 'authenticated',
      exp: nowSeconds() + 3600,
    });
    const response = await request('/api/admin/users', {
      ...createBody,
      headers: { ...createBody.headers, Authorization: `Bearer ${forged}` },
    });

    expect(response.status).toBe(401);
    expect(stub.restRequests).toHaveLength(0);
  });

  it('401 for an expired token', async () => {
    stub = installSupabaseStub({ jwks: { keys: [signingKey.jwk] }, isAdmin: true });

    const token = await userToken({ exp: nowSeconds() - 3600 });
    const response = await request('/api/admin/users', {
      ...createBody,
      headers: { ...createBody.headers, Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(401);
  });

  it('403 with a valid token from an account that is not an administrator', async () => {
    stub = installSupabaseStub({ jwks: { keys: [signingKey.jwk] }, isAdmin: false });

    const token = await userToken();
    const response = await request('/api/admin/users', {
      ...createBody,
      headers: { ...createBody.headers, Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(403);
    expect((await response.json<ApiErrorBody>()).error.kind).toBe('forbidden');

    // The distinction that matters: the token verified, so the Worker went and
    // asked the DATABASE whether this identity is an admin.
    const rpc = stub.restRequests.find((r) => r.path === '/rest/v1/rpc/is_admin');
    expect(rpc).toBeDefined();
    expect(rpc?.authorization).toBe(`Bearer ${token}`);

    // And it never attempted the write.
    expect(
      stub.restRequests.filter((r) => r.method === 'POST' && r.path === '/rest/v1/app_users'),
    ).toHaveLength(0);
  });

  it('201 for a real administrator, with the write carrying THEIR token', async () => {
    stub = installSupabaseStub({ jwks: { keys: [signingKey.jwk] }, isAdmin: true });

    const token = await userToken();
    const response = await request('/api/admin/users', {
      ...createBody,
      headers: { ...createBody.headers, Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(201);
    expect((await response.json<CreateUserResponse>()).user.displayName).toBe('New Person');

    // Not the anon key, and not a service-role key: the administrator's own
    // token, so RLS can see who is asking (§30, §31).
    const insert = stub.restRequests.find(
      (r) => r.method === 'POST' && r.path === '/rest/v1/app_users',
    );
    expect(insert?.authorization).toBe(`Bearer ${token}`);
    expect(insert?.apikey).toBe('test-anon-key');
  });

  it('400, not 500, for a malformed body', async () => {
    stub = installSupabaseStub({ jwks: { keys: [signingKey.jwk] }, isAdmin: true });

    const token = await userToken();
    const response = await request('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ displayName: '   ' }),
    });

    expect(response.status).toBe(400);
    expect((await response.json<ApiErrorBody>()).error.kind).toBe('invalid_request');
  });

  it('401 when the project publishes no signing keys at all', async () => {
    // A Supabase project still on the legacy HS256 secret. Must fail closed and
    // loudly rather than skipping verification.
    stub = installSupabaseStub({ jwks: { keys: [] }, isAdmin: true });

    const token = await userToken();
    const response = await request('/api/admin/users', {
      ...createBody,
      headers: { ...createBody.headers, Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(401);
  });

  it('caches the key set instead of fetching it per request', async () => {
    stub = installSupabaseStub({ jwks: { keys: [signingKey.jwk] }, isAdmin: true });

    const token = await userToken();
    const headers = { ...createBody.headers, Authorization: `Bearer ${token}` };
    await request('/api/admin/users', { ...createBody, headers });
    await request('/api/admin/users', { ...createBody, headers });
    await request('/api/admin/users', { ...createBody, headers });

    expect(stub.jwksFetches).toBe(1);
  });

  it('refetches the key set once when a token carries an unknown kid (rotation)', async () => {
    const rotated = await generateSigningKey('ES256', 'rotated-key');
    let served = [signingKey.jwk];

    stub = installSupabaseStub({
      isAdmin: true,
      routes: [
        {
          match: (url) => url.pathname === '/auth/v1/.well-known/jwks.json',
          respond: () => {
            // The second fetch — the forced refresh — sees the new key.
            const body = { keys: served };
            served = [rotated.jwk];
            return { status: 200, body };
          },
        },
      ],
    });

    const token = await signToken(rotated, {
      sub: 'auth-user-1',
      iss: TEST_ISSUER,
      aud: 'authenticated',
      exp: nowSeconds() + 3600,
    });

    const response = await request('/api/admin/users', {
      ...createBody,
      headers: { ...createBody.headers, Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(201);
  });
});

describe('GET /api/admin/session — what the web app asks before showing /admin', () => {
  it('401 with no token', async () => {
    stub = installSupabaseStub({ jwks: { keys: [signingKey.jwk] }, isAdmin: true });

    const response = await request('/api/admin/session');
    expect(response.status).toBe(401);
    expect((await response.json<ApiErrorBody>()).error.kind).toBe('unauthorized');
  });

  it('403 for a signed-in account that is not an administrator', async () => {
    stub = installSupabaseStub({ jwks: { keys: [signingKey.jwk] }, isAdmin: false });

    const token = await userToken();
    const response = await request('/api/admin/session', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
    expect((await response.json<ApiErrorBody>()).error.kind).toBe('forbidden');
  });

  it('200 for an administrator, never cached', async () => {
    stub = installSupabaseStub({ jwks: { keys: [signingKey.jwk] }, isAdmin: true });

    const token = await userToken();
    const response = await request('/api/admin/session', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json<AdminSessionResponse>()).toEqual({
      admin: { authUserId: 'auth-user-1' },
    });
    // It writes nothing: the only PostgREST call is the is_admin() check.
    expect(stub.restRequests.map((r) => r.path)).toEqual(['/rest/v1/rpc/is_admin']);
  });
});

describe('the admin branch is the only place JWT work happens', () => {
  it('a public read never fetches the key set', async () => {
    stub = installSupabaseStub({ jwks: { keys: [signingKey.jwk] }, appUsers: nineSeededUsers() });

    await request('/api/users');
    await request('/api/health');
    await request('/api/meta/season');

    expect(stub.jwksFetches).toBe(0);
  });

  it('a stray bearer token on a public read is ignored, not verified', async () => {
    stub = installSupabaseStub({ jwks: { keys: [signingKey.jwk] }, appUsers: nineSeededUsers() });

    const response = await request('/api/users', {
      headers: { Authorization: 'Bearer complete-nonsense' },
    });

    expect(response.status).toBe(200);
    expect(stub.jwksFetches).toBe(0);
    // Still read as anon — a supplied token must not be forwarded, and must not
    // silently turn a public read into an authenticated one.
    expect(stub.restRequests[0]?.authorization).toBeNull();
  });
});
