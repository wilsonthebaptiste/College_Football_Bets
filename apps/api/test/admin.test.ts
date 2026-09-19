import type {
  AddSelectionResponse,
  AdminBoardResponse,
  AdminUsersResponse,
  ApiErrorBody,
  BoardResponse,
  RenameUserResponse,
  SelectionsResponse,
  TeamSearchResponse,
} from '@cfb/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { resetJwksCache } from '../src/auth/jwks';
import { resetInflight } from '../src/cache/swr';
import { resetCacheTiers } from '../src/cache/tiers';
import type { Env } from '../src/env';
import { resetRateLimits } from '../src/middleware/rate-limit';
import { createFakeDb, type FakeDb } from './helpers/admin-db';
import { uuidFor } from './helpers/boards';
import { espnResponse } from './helpers/espn-stub';
import {
  installSupabaseStub,
  TEST_ISSUER,
  testEnv,
  type SupabaseStub,
} from './helpers/supabase-stub';
import {
  base64UrlEncode,
  forgeAlgNoneToken,
  forgeHs256Token,
  generateSigningKey,
  nowSeconds,
  signToken,
  type SigningKeyPair,
} from './helpers/tokens';

/**
 * Plan §5.1 and §5.2: the admin console's API, and the negative authorization
 * tests the plan calls "first-class deliverables". With reads public, the write
 * path is the only security boundary in the application.
 *
 * The matrix below runs every `/api/admin/*` route through every way a caller
 * can fail to be an administrator. It checks itself against the router: a new
 * admin route that is not added to `ADMIN_ROUTES` fails the first test.
 */

let signingKey: SigningKeyPair;
let stub: SupabaseStub | undefined;
let db: FakeDb;

const WILSON = uuidFor(9001);
const JORDAN = uuidFor(9002);

beforeAll(async () => {
  signingKey = await generateSigningKey('ES256', 'test-key');
});

beforeEach(() => {
  resetJwksCache();
  resetCacheTiers();
  resetInflight();
  resetRateLimits();
  db = createFakeDb({
    [WILSON]: { name: 'Wilson', teams: ['333', '61', '251', '130', '30', '99'] },
    [JORDAN]: { name: 'Jordan', teams: ['333', '194'] },
  });
});

afterEach(() => {
  stub?.restore();
});

const app = createApp();

function install(isAdmin = true, espn = false): SupabaseStub {
  stub = installSupabaseStub({
    jwks: { keys: [signingKey.jwk] },
    isAdmin,
    routes: db.routes,
    ...(espn ? { external: (url: URL) => espnResponse(url) } : {}),
  });
  return stub;
}

const token = (claims: Record<string, unknown> = {}): Promise<string> =>
  signToken(signingKey, {
    sub: 'auth-user-1',
    iss: TEST_ISSUER,
    aud: 'authenticated',
    iat: nowSeconds() - 10,
    exp: nowSeconds() + 3600,
    ...claims,
  });

interface Call {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
}

async function call(
  { method, path, body }: Call,
  bearer: string | null,
  env: Env = testEnv(),
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (bearer !== null) headers['Authorization'] = bearer;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(
    path,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    env,
  );
}

const firstSelectionOf = (userId: string): string =>
  db.selections
    .filter((selection) => selection.user_id === userId)
    .sort((a, b) => a.selection_order - b.selection_order)[0]!.id;

/** Every admin route, as the router registers it, with a call that would otherwise succeed. */
const ADMIN_ROUTES: { route: string; call: () => Call }[] = [
  { route: 'GET /api/admin/session', call: () => ({ method: 'GET', path: '/api/admin/session' }) },
  { route: 'GET /api/admin/users', call: () => ({ method: 'GET', path: '/api/admin/users' }) },
  {
    route: 'POST /api/admin/users',
    call: () => ({ method: 'POST', path: '/api/admin/users', body: { displayName: 'Probe' } }),
  },
  {
    route: 'GET /api/admin/users/:userId',
    call: () => ({ method: 'GET', path: `/api/admin/users/${WILSON}` }),
  },
  {
    route: 'PATCH /api/admin/users/:userId',
    call: () => ({
      method: 'PATCH',
      path: `/api/admin/users/${WILSON}`,
      body: { displayName: 'Renamed' },
    }),
  },
  {
    route: 'DELETE /api/admin/users/:userId',
    call: () => ({ method: 'DELETE', path: `/api/admin/users/${JORDAN}` }),
  },
  {
    route: 'POST /api/admin/users/:userId/selections',
    call: () => ({
      method: 'POST',
      path: `/api/admin/users/${JORDAN}/selections`,
      body: { providerTeamId: '2572' },
    }),
  },
  {
    route: 'DELETE /api/admin/selections/:selectionId',
    call: () => ({ method: 'DELETE', path: `/api/admin/selections/${firstSelectionOf(JORDAN)}` }),
  },
  {
    route: 'PUT /api/admin/users/:userId/selections/order',
    call: () => ({
      method: 'PUT',
      path: `/api/admin/users/${JORDAN}/selections/order`,
      body: {
        orderedIds: db.selections
          .filter((selection) => selection.user_id === JORDAN)
          .map((selection) => selection.id)
          .reverse(),
      },
    }),
  },
  {
    route: 'GET /api/admin/teams/search',
    call: () => ({ method: 'GET', path: '/api/admin/teams/search?q=alabama' }),
  },
];

/** Writes and RPCs other than `is_admin`: what must never happen for a refused caller. */
function writesAttempted(): string[] {
  return (stub?.restRequests ?? [])
    .filter((request) => request.method !== 'GET' && request.path !== '/rest/v1/rpc/is_admin')
    .map((request) => `${request.method} ${request.path}`);
}

// ─── §5.2: the authorization matrix ──────────────────────────────────────────

describe('every /api/admin/* route refuses every non-administrator (plan §5.2)', () => {
  it('the matrix covers every admin route the router has', () => {
    const registered = new Set(
      app.routes
        .filter((route) => route.path.startsWith('/api/admin/') && route.method !== 'ALL')
        .map((route) => `${route.method} ${route.path}`),
    );
    expect([...registered].sort()).toEqual(ADMIN_ROUTES.map((entry) => entry.route).sort());
  });

  describe.each(ADMIN_ROUTES)('$route', ({ call: build }) => {
    it('401 with no token, and never reaches the database', async () => {
      install();
      const response = await call(build(), null);
      expect(response.status).toBe(401);
      expect((await response.json<ApiErrorBody>()).error.kind).toBe('unauthorized');
      expect(stub!.restRequests).toHaveLength(0);
    });

    it('401 for a non-Bearer Authorization header', async () => {
      install();
      expect((await call(build(), 'Basic YWRtaW46YWRtaW4=')).status).toBe(401);
      expect(stub!.restRequests).toHaveLength(0);
    });

    it('401 for an alg:none forgery', async () => {
      install();
      const forged = forgeAlgNoneToken({
        sub: 'auth-user-1',
        iss: TEST_ISSUER,
        aud: 'authenticated',
        exp: nowSeconds() + 3600,
      });
      expect((await call(build(), `Bearer ${forged}`)).status).toBe(401);
      expect(stub!.restRequests).toHaveLength(0);
    });

    it('401 for an HS256 token keyed with the public key (algorithm confusion)', async () => {
      install();
      const forged = await forgeHs256Token(
        { sub: 'auth-user-1', iss: TEST_ISSUER, aud: 'authenticated', exp: nowSeconds() + 3600 },
        JSON.stringify(signingKey.jwk),
      );
      expect((await call(build(), `Bearer ${forged}`)).status).toBe(401);
      expect(stub!.restRequests).toHaveLength(0);
    });

    it('401 for a tampered token: real signature, edited claims', async () => {
      install();
      const [header, , signature] = (await token()).split('.');
      const edited = base64UrlEncode(
        new TextEncoder().encode(
          JSON.stringify({
            sub: 'someone-else',
            iss: TEST_ISSUER,
            aud: 'authenticated',
            exp: nowSeconds() + 3600,
          }),
        ),
      );
      expect((await call(build(), `Bearer ${header}.${edited}.${signature}`)).status).toBe(401);
      expect(stub!.restRequests).toHaveLength(0);
    });

    it('401 for an expired token', async () => {
      install();
      const expired = await token({ exp: nowSeconds() - 60, iat: nowSeconds() - 3600 });
      expect((await call(build(), `Bearer ${expired}`)).status).toBe(401);
      expect(stub!.restRequests).toHaveLength(0);
    });

    it('401 for a token from another project (wrong issuer)', async () => {
      install();
      const foreign = await token({ iss: 'https://other-project.supabase.co/auth/v1' });
      expect((await call(build(), `Bearer ${foreign}`)).status).toBe(401);
    });

    it('403 for a valid token that is not an administrator, with no write attempted', async () => {
      install(false);
      const response = await call(build(), `Bearer ${await token()}`);
      expect(response.status).toBe(403);
      expect((await response.json<ApiErrorBody>()).error.kind).toBe('forbidden');
      // The token verified, so the Worker asked the DATABASE, with that token.
      expect(stub!.restRequests.map((request) => request.path)).toEqual(['/rest/v1/rpc/is_admin']);
      expect(writesAttempted()).toEqual([]);
    });

    it('is allowed through for an administrator', async () => {
      install(true);
      const response = await call(build(), `Bearer ${await token()}`);
      expect([401, 403]).not.toContain(response.status);
      expect(response.status).toBeLessThan(300);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });
  });
});

// ─── §5.1: what the console does ─────────────────────────────────────────────

async function asAdmin(request: Call): Promise<Response> {
  return call(request, `Bearer ${await token()}`);
}

describe('users (plan §5.1)', () => {
  it('lists users with team counts, read with the admin token', async () => {
    install();
    const bearer = await token();
    const response = await call({ method: 'GET', path: '/api/admin/users' }, `Bearer ${bearer}`);
    const body = await response.json<AdminUsersResponse>();
    expect(body.users).toEqual([
      { id: JORDAN, displayName: 'Jordan', teamCount: 2 },
      { id: WILSON, displayName: 'Wilson', teamCount: 6 },
    ]);
    const read = stub!.restRequests.find((request) =>
      request.path.startsWith('/rest/v1/app_users'),
    );
    expect(read?.authorization).toBe(`Bearer ${bearer}`);
  });

  it('renames a user, trimming the name', async () => {
    install();
    const response = await asAdmin({
      method: 'PATCH',
      path: `/api/admin/users/${WILSON}`,
      body: { displayName: '  Wilson B.  ' },
    });
    expect(response.status).toBe(200);
    expect((await response.json<RenameUserResponse>()).user).toEqual({
      id: WILSON,
      displayName: 'Wilson B.',
    });
    expect(db.users.find((user) => user.id === WILSON)?.display_name).toBe('Wilson B.');
  });

  it.each([
    ['blank', { displayName: '   ' }],
    ['too long', { displayName: 'x'.repeat(61) }],
    ['not a string', { displayName: 7 }],
    ['missing', {}],
  ])('400 for a %s name, with nothing written', async (_label, body) => {
    install();
    const response = await asAdmin({ method: 'PATCH', path: `/api/admin/users/${WILSON}`, body });
    expect(response.status).toBe(400);
    expect((await response.json<ApiErrorBody>()).error.kind).toBe('invalid_request');
    expect(writesAttempted()).toEqual([]);
  });

  it('400 for a body that is not JSON', async () => {
    install();
    const response = await app.request(
      `/api/admin/users/${WILSON}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
        body: '{not json',
      },
      testEnv(),
    );
    expect(response.status).toBe(400);
  });

  it('404 when renaming or deleting a user that does not exist', async () => {
    install();
    const ghost = uuidFor(123_456);
    expect(
      (
        await asAdmin({
          method: 'PATCH',
          path: `/api/admin/users/${ghost}`,
          body: { displayName: 'X' },
        })
      ).status,
    ).toBe(404);
    expect((await asAdmin({ method: 'DELETE', path: `/api/admin/users/${ghost}` })).status).toBe(
      404,
    );
    expect((await asAdmin({ method: 'DELETE', path: '/api/admin/users/not-a-uuid' })).status).toBe(
      404,
    );
  });

  it('deletes a user and, by cascade, their board; the teams stay', async () => {
    install();
    const teamsBefore = db.teams.length;
    const response = await asAdmin({ method: 'DELETE', path: `/api/admin/users/${JORDAN}` });
    expect(response.status).toBe(204);
    expect(db.users.some((user) => user.id === JORDAN)).toBe(false);
    expect(db.selections.some((selection) => selection.user_id === JORDAN)).toBe(false);
    expect(db.teams).toHaveLength(teamsBefore);
  });

  it('reads one board for the editor, in order', async () => {
    install();
    const response = await asAdmin({ method: 'GET', path: `/api/admin/users/${WILSON}` });
    const body = await response.json<AdminBoardResponse>();
    expect(body.user.displayName).toBe('Wilson');
    expect(body.selections.map((selection) => selection.team.providerTeamId)).toEqual([
      '333',
      '61',
      '251',
      '130',
      '30',
      '99',
    ]);
  });
});

describe('adding a team (§3, §43)', () => {
  const add = (userId: string, providerTeamId: unknown): Call => ({
    method: 'POST',
    path: `/api/admin/users/${userId}/selections`,
    body: { providerTeamId },
  });

  it('stores a team the first time any board takes it, with its provider identity and conference', async () => {
    install();
    expect(db.teams.some((team) => team['provider_team_id'] === '2572')).toBe(false);

    const response = await asAdmin(add(JORDAN, '2572'));
    expect(response.status).toBe(201);
    const body = await response.json<AddSelectionResponse>();

    expect(body.selection.team).toMatchObject({
      providerTeamId: '2572',
      name: 'Southern Miss Golden Eagles',
      displayName: 'Southern Miss',
      conference: 'Sun Belt',
      // The mock borrows ESPN's ids, so the row is ESPN's, not a mock-only duplicate.
      provider: 'espn',
    });
    expect(body.selection.order).toBe(3);
    expect(body.selections.map((selection) => selection.team.providerTeamId)).toEqual([
      '333',
      '194',
      '2572',
    ]);
    expect(db.teams.filter((team) => team['provider_team_id'] === '2572')).toHaveLength(1);
  });

  it('reuses a team already stored rather than inserting it again', async () => {
    install();
    const teamsBefore = db.teams.length;
    const response = await asAdmin(add(JORDAN, '61')); // Georgia, on Wilson's board already
    expect(response.status).toBe(201);
    expect(db.teams).toHaveLength(teamsBefore);
    expect(
      stub!.restRequests.filter(
        (request) => request.path === '/rest/v1/teams' && request.method === 'POST',
      ),
    ).toHaveLength(0);
  });

  it('every write carries the administrator’s own token, never another key', async () => {
    install();
    const bearer = await token();
    await call(add(JORDAN, '2572'), `Bearer ${bearer}`);
    const writes = stub!.restRequests.filter((request) => request.method === 'POST');
    expect(writes.length).toBeGreaterThan(1);
    for (const write of writes) {
      expect(write.authorization).toBe(`Bearer ${bearer}`);
      expect(write.apikey).toBe('test-anon-key');
    }
  });

  it('409 for a team already on the board, before any write', async () => {
    install();
    const response = await asAdmin(add(WILSON, '333'));
    expect(response.status).toBe(409);
    const body = await response.json<ApiErrorBody>();
    expect(body.error.kind).toBe('conflict');
    expect(body.error.message).toBe('That team is already on this board.');
    expect(writesAttempted()).toEqual([]);
  });

  it('the database constraint still has the last word (a duplicate that slips past the check)', async () => {
    install();
    // Simulate a second tab adding Ohio State between this request's read and its insert.
    const original = db.routes.find((route) =>
      route.match(new URL('https://x/rest/v1/user_team_selections'), 'POST'),
    )!;
    const respond = original.respond;
    original.respond = (request) => {
      const row = request.body as { user_id: string; team_id: string };
      db.selections.push({
        id: uuidFor(888_888),
        user_id: row.user_id,
        team_id: row.team_id,
        selection_order: 99,
        created_at: '2026-09-19T00:00:00Z',
      });
      return respond(request);
    };
    const response = await asAdmin(add(JORDAN, '2572'));
    expect(response.status).toBe(409);
    expect((await response.json<ApiErrorBody>()).error.message).toBe(
      'That team is already on this board.',
    );
  });

  it('404 for a team the provider does not list; 400 for an id that is not an id', async () => {
    install();
    expect((await asAdmin(add(JORDAN, '999999'))).status).toBe(404);
    expect((await asAdmin(add(JORDAN, '../teams'))).status).toBe(400);
    expect((await asAdmin(add(JORDAN, 333))).status).toBe(400);
    expect(writesAttempted()).toEqual([]);
  });

  it('404 for a board that does not exist', async () => {
    install();
    expect((await asAdmin(add(uuidFor(42), '333'))).status).toBe(404);
  });

  it('closes numbering gaps rather than run into the 24-slot ceiling', async () => {
    install();
    // Jordan's two teams sit at slots 23 and 24, as if 22 teams had come and gone.
    const mine = db.selections.filter((selection) => selection.user_id === JORDAN);
    mine[0]!.selection_order = 23;
    mine[1]!.selection_order = 24;

    const response = await asAdmin(add(JORDAN, '2572'));
    expect(response.status).toBe(201);
    const body = await response.json<AddSelectionResponse>();
    expect(body.selections.map((selection) => selection.order)).toEqual([1, 2, 3]);
    expect(db.reorders).toHaveLength(1);
  });

  it('503, not a crash, when the provider team list cannot be read', async () => {
    install();
    const response = await call(
      add(JORDAN, '2572'),
      `Bearer ${await token()}`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'teams' }),
    );
    expect(response.status).toBe(503);
    expect(writesAttempted()).toEqual([]);
  });

  it('still adds the team when conferences cannot be read', async () => {
    install();
    const response = await call(
      add(JORDAN, '2572'),
      `Bearer ${await token()}`,
      testEnv({ SPORTS_PROVIDER_FAULT: 'conferences' }),
    );
    expect(response.status).toBe(201);
  });
});

describe('removing a team', () => {
  it('removes one selection and renumbers the rest 1…n in one reorder', async () => {
    install();
    const second = db.selections
      .filter((selection) => selection.user_id === WILSON)
      .sort((a, b) => a.selection_order - b.selection_order)[1]!;

    const response = await asAdmin({
      method: 'DELETE',
      path: `/api/admin/selections/${second.id}`,
    });
    expect(response.status).toBe(200);
    const body = await response.json<SelectionsResponse>();
    expect(body.userId).toBe(WILSON);
    expect(body.selections.map((selection) => selection.team.providerTeamId)).toEqual([
      '333',
      '251',
      '130',
      '30',
      '99',
    ]);
    expect(body.selections.map((selection) => selection.order)).toEqual([1, 2, 3, 4, 5]);
    expect(db.reorders).toHaveLength(1);
  });

  it('removing the last team needs no renumbering', async () => {
    install();
    const last = db.selections
      .filter((selection) => selection.user_id === JORDAN)
      .sort((a, b) => b.selection_order - a.selection_order)[0]!;
    await asAdmin({ method: 'DELETE', path: `/api/admin/selections/${last.id}` });
    expect(db.reorders).toHaveLength(0);
  });

  it('404 for a selection that does not exist', async () => {
    install();
    expect(
      (await asAdmin({ method: 'DELETE', path: `/api/admin/selections/${uuidFor(1)}` })).status,
    ).toBe(404);
    expect((await asAdmin({ method: 'DELETE', path: '/api/admin/selections/nope' })).status).toBe(
      404,
    );
  });
});

describe('reordering (§44)', () => {
  const idsOf = (userId: string) =>
    db.selections
      .filter((selection) => selection.user_id === userId)
      .sort((a, b) => a.selection_order - b.selection_order)
      .map((selection) => selection.id);

  const reorder = (userId: string, orderedIds: unknown): Call => ({
    method: 'PUT',
    path: `/api/admin/users/${userId}/selections/order`,
    body: { orderedIds },
  });

  it('applies the whole order in one reorder_selections call', async () => {
    install();
    const ids = idsOf(WILSON);
    const moved = [ids[1]!, ids[0]!, ...ids.slice(2)]; // Georgia up above Alabama

    const response = await asAdmin(reorder(WILSON, moved));
    expect(response.status).toBe(200);
    const body = await response.json<SelectionsResponse>();
    expect(body.selections.map((selection) => selection.team.providerTeamId)).toEqual([
      '61',
      '333',
      '251',
      '130',
      '30',
      '99',
    ]);
    expect(db.reorders).toEqual([{ userId: WILSON, ids: moved }]);
    const rpc = stub!.restRequests.filter(
      (request) => request.path === '/rest/v1/rpc/reorder_selections',
    );
    expect(rpc).toHaveLength(1);
  });

  it('409 when the list is not exactly the board (it changed in another tab)', async () => {
    install();
    const ids = idsOf(WILSON);
    for (const orderedIds of [ids.slice(1), [...ids.slice(1), idsOf(JORDAN)[0]!]]) {
      const response = await asAdmin(reorder(WILSON, orderedIds));
      expect(response.status).toBe(409);
      expect((await response.json<ApiErrorBody>()).error.kind).toBe('conflict');
    }
    expect(db.reorders).toHaveLength(0);
  });

  it.each([
    ['empty', []],
    ['not a list', 'abc'],
    ['not uuids', ['1', '2']],
    ['a repeat', 'repeat'],
    ['too many', 'many'],
  ])('400 for %s, with no RPC', async (_label, raw) => {
    install();
    const ids = idsOf(WILSON);
    const orderedIds =
      raw === 'repeat'
        ? [ids[0], ids[0], ...ids.slice(2)]
        : raw === 'many'
          ? Array.from({ length: 25 }, (_, i) => uuidFor(i))
          : raw;
    const response = await asAdmin(reorder(WILSON, orderedIds));
    expect(response.status).toBe(400);
    expect(db.reorders).toHaveLength(0);
  });
});

describe('the database is the boundary, not the Worker (§30, §31)', () => {
  it('a write RLS refuses is a 403, even when is_admin() said yes', async () => {
    install(true);
    db.refuseWrites = true;
    const response = await asAdmin({
      method: 'POST',
      path: '/api/admin/users',
      body: { displayName: 'X' },
    });
    expect(response.status).toBe(403);
    expect((await response.json<ApiErrorBody>()).error.kind).toBe('forbidden');
  });

  it('an update RLS hides (zero rows) is a 404, never a false success', async () => {
    install(true);
    db.refuseWrites = true;
    const response = await asAdmin({
      method: 'PATCH',
      path: `/api/admin/users/${WILSON}`,
      body: { displayName: 'X' },
    });
    expect(response.status).toBe(404);
    expect(db.users.find((user) => user.id === WILSON)?.display_name).toBe('Wilson');
  });

  it('a refused reorder is a 403', async () => {
    install(true);
    db.refuseWrites = true;
    const ids = db.selections
      .filter((selection) => selection.user_id === WILSON)
      .map((selection) => selection.id);
    const response = await asAdmin({
      method: 'PUT',
      path: `/api/admin/users/${WILSON}/selections/order`,
      body: { orderedIds: ids },
    });
    expect(response.status).toBe(403);
  });
});

describe('the public board reflects an admin change on the next read (exit criterion)', () => {
  it('a reorder drops the cached board, so the next read has the new order', async () => {
    install();
    const board = async () =>
      (
        await (await app.request(`/api/users/${WILSON}/board`, {}, testEnv())).json<BoardResponse>()
      ).teams.map((team) => team.team.providerTeamId);

    expect(await board()).toEqual(['333', '61', '251', '130', '30', '99']);
    // Served from the board's own L1 cache now…
    expect(await board()).toEqual(['333', '61', '251', '130', '30', '99']);

    const ids = db.selections
      .filter((selection) => selection.user_id === WILSON)
      .sort((a, b) => a.selection_order - b.selection_order)
      .map((selection) => selection.id);
    await asAdmin({
      method: 'PUT',
      path: `/api/admin/users/${WILSON}/selections/order`,
      body: { orderedIds: [...ids].reverse() },
    });

    // …and not after the write.
    expect(await board()).toEqual(['99', '30', '130', '251', '61', '333']);
  });

  it('an added or removed team shows on the next read too', async () => {
    install();
    const board = async () =>
      (
        await (await app.request(`/api/users/${JORDAN}/board`, {}, testEnv())).json<BoardResponse>()
      ).teams.map((team) => team.team.providerTeamId);
    expect(await board()).toEqual(['333', '194']);
    await asAdmin({
      method: 'POST',
      path: `/api/admin/users/${JORDAN}/selections`,
      body: { providerTeamId: '2572' },
    });
    expect(await board()).toEqual(['333', '194', '2572']);
    await asAdmin({ method: 'DELETE', path: `/api/admin/selections/${firstSelectionOf(JORDAN)}` });
    expect(await board()).toEqual(['194', '2572']);
  });
});

describe('team search (§43, plan §5.1)', () => {
  const search = (q: string, env: Env) =>
    token().then((bearer) =>
      call({ method: 'GET', path: `/api/admin/teams/search?q=${q}` }, `Bearer ${bearer}`, env),
    );
  const espn = (overrides: Partial<Env> = {}) => testEnv({ SPORTS_PROVIDER: 'espn', ...overrides });

  it('ESPN: each result carries its conference, from the core API, and a sized logo', async () => {
    install(true, true);
    const { teams } = await (await search('alabama', espn())).json<TeamSearchResponse>();
    expect(teams[0]).toMatchObject({
      providerTeamId: '333',
      name: 'Alabama Crimson Tide',
      conference: 'SEC',
      logoUrl: 'https://a.espncdn.com/combiner/i?img=/i/teamlogos/ncaa/500/333.png&w=144&h=144',
    });
  });

  it('ESPN: with conferences failing, search still answers, without them', async () => {
    install(true, true);
    const response = await search('alabama', espn({ SPORTS_PROVIDER_FAULT: 'conferences' }));
    expect(response.status).toBe(200);
    const { teams } = await response.json<TeamSearchResponse>();
    expect(teams[0]).toMatchObject({ providerTeamId: '333', conference: null });
  });

  it('ESPN: a new team is stored with the canonical logo URL and its conference', async () => {
    install(true, true);
    // Vanderbilt (238) is SEC and is on no seeded board.
    const response = await call(
      {
        method: 'POST',
        path: `/api/admin/users/${JORDAN}/selections`,
        body: { providerTeamId: '238' },
      },
      `Bearer ${await token()}`,
      espn(),
    );
    expect(response.status).toBe(201);
    const stored = db.teams.find((team) => team['provider_team_id'] === '238');
    expect(stored).toMatchObject({
      provider: 'espn',
      conference: 'SEC',
      logo_url: 'https://a.espncdn.com/i/teamlogos/ncaa/500/238.png',
    });
    // What the API hands out is the sized copy.
    const body = await response.json<AddSelectionResponse>();
    expect(body.selection.team.logoUrl).toContain('/combiner/i?img=/i/teamlogos/ncaa/500/238.png');
  });

  it('mock: results carry the roster conference', async () => {
    install();
    const { teams } = await (await search('southern', testEnv())).json<TeamSearchResponse>();
    expect(teams[0]).toMatchObject({ providerTeamId: '2572', conference: 'Sun Belt' });
  });

  it('400 for a query too short to be useful', async () => {
    install();
    expect((await search('a', testEnv())).status).toBe(400);
  });
});
