/**
 * Smoke test for a running Worker, local or deployed (docs/ops.md, "Deploying").
 *
 *   npm run smoke -- https://cfb-api.<your-subdomain>.workers.dev
 *   npm run smoke -- http://127.0.0.1:8787
 *
 * Read-only. It makes about twenty requests, well inside any rate limit, and
 * writes nothing: the admin checks only prove that the door is shut.
 *
 * An optional second argument is the site's origin, to check CORS:
 *
 *   npm run smoke -- https://cfb-api.x.workers.dev https://cfb-board.pages.dev
 */

const [base = '', siteOrigin = null] = process.argv.slice(2);
const API = base.replace(/\/+$/, '');
if (!/^https?:\/\//.test(API)) {
  console.error('Usage: npm run smoke -- <worker base URL> [site origin]');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const check = (ok, name, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`);
};

async function get(path, init = {}) {
  const started = Date.now();
  const response = await fetch(`${API}${path}`, init);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body, ms: Date.now() - started };
}

const unsigned = (claims) =>
  `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;

console.log(`\nSmoke test against ${API}\n`);

// ── Health ──────────────────────────────────────────────────────────────────
const health = await get('/api/health');
check(health.status === 200 && health.body?.status === 'ok', 'GET /api/health', `${health.ms} ms`);
if (health.status === 200) {
  const { provider, season, seasonSource, cache } = health.body;
  console.log(
    `      provider ${provider}, season ${season.year} ${season.type} (${seasonSource}), L2 ${cache.l2Available ? 'working' : 'inert'}, KV writes today in this isolate ${cache.kvWrites.total}`,
  );
}
check(health.headers.get('x-request-id') !== null, 'every response carries X-Request-Id');

// ── Public reads, no token ──────────────────────────────────────────────────
const users = await get('/api/users');
const list = users.body?.users ?? [];
check(
  users.status === 200 && list.length > 0,
  'GET /api/users with no token',
  `${list.length} boards`,
);
check(/public, max-age=\d+/.test(users.headers.get('cache-control') ?? ''), '  cacheable');

const owner = list.find((user) => user.teamCount > 0) ?? list[0];
if (owner !== undefined) {
  const board = await get(`/api/users/${owner.id}/board`);
  const teams = board.body?.teams ?? [];
  const filled = teams.filter((team) => team.snapshot?.data !== null).length;
  check(
    board.status === 200,
    `GET board of ${owner.displayName}`,
    `${board.ms} ms, ${String(JSON.stringify(board.body).length)} bytes`,
  );
  check(filled === teams.length, '  every card has sports data', `${filled} of ${teams.length}`);
  check(
    /max-age|no-store/.test(board.headers.get('cache-control') ?? ''),
    '  Cache-Control set',
    board.headers.get('cache-control') ?? '',
  );
  console.log(
    `      X-Cache ${board.headers.get('x-cache')}, provider ${board.body?.freshness?.provider}`,
  );

  const first = teams[0]?.team;
  if (first !== undefined) {
    const team = await get(`/api/teams/${first.id}`);
    check(
      team.status === 200 && team.body?.snapshot?.data !== null,
      `GET team ${first.displayName ?? first.name}`,
      `${team.ms} ms`,
    );
    const schedule = await get(`/api/teams/${first.id}/schedule`);
    const items = schedule.body?.schedule?.data?.items ?? [];
    check(schedule.status === 200 && items.length > 0, '  schedule', `${items.length} rows`);
    const next = team.body?.snapshot?.data?.nextGame;
    const game = next?.kind === 'game' ? next.game : next?.kind === 'bye' ? next.following : null;
    if (game) {
      const prediction = await get(`/api/games/${game.providerGameId}/prediction`);
      const p = prediction.body?.prediction;
      check(
        prediction.status === 200,
        '  prediction answers (a value or a labelled absence)',
        p?.data ? p.data.sourceLabel : 'unavailable',
      );
    }

    // ── Search, and the team page it links to ───────────────────────────────
    // A board team is used as the query so this works against any provider and
    // any set of real boards: whatever is on screen must be findable.
    const query = (first.displayName ?? first.name).slice(0, 60);
    const results = await get(`/api/search/teams?q=${encodeURIComponent(query)}`);
    const hits = results.body?.teams ?? [];
    check(
      results.status === 200 && hits.some((t) => t.providerTeamId === first.providerTeamId),
      `GET /api/search/teams?q=${query} finds it`,
      `${hits.length} of at most 20, ${results.ms} ms`,
    );
    check(
      /public, max-age=\d+/.test(results.headers.get('cache-control') ?? ''),
      '  cacheable, so a keystroke is not a Worker request',
      results.headers.get('cache-control') ?? '',
    );

    // The page a result opens: the same team by the provider's id, with no row
    // of ours behind it (`team.id` is null) and the whole snapshot regardless.
    const searched = await get(`/api/teams/${first.providerTeamId}`);
    check(
      searched.status === 200 && searched.body?.team?.id === null,
      `GET team by provider id ${first.providerTeamId}`,
      `${searched.ms} ms, id ${JSON.stringify(searched.body?.team?.id)}`,
    );
    check(
      searched.body?.snapshot?.data !== null && searched.body?.snapshot?.data !== undefined,
      '  a searched team page shows what a board team shows',
      searched.body?.team?.name ?? '',
    );
  }
}

const shortQuery = await get('/api/search/teams?q=a');
check(
  shortQuery.status === 400,
  'GET /api/search/teams?q=a → 400 (the client must not ask below two)',
  String(shortQuery.status),
);

// ── The admin door is shut ──────────────────────────────────────────────────
const session = await get('/api/admin/session');
check(session.status === 401, 'GET /api/admin/session with no token → 401', String(session.status));
const write = await get('/api/admin/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ displayName: 'smoke' }),
});
check(write.status === 401, 'POST /api/admin/users with no token → 401', String(write.status));
const forged = await get('/api/admin/users', {
  headers: {
    Authorization: `Bearer ${unsigned({ sub: 'x', aud: 'authenticated', exp: 9999999999 })}`,
  },
});
check(forged.status === 401, 'an alg:none token → 401', String(forged.status));

// ── CORS ────────────────────────────────────────────────────────────────────
if (siteOrigin !== null) {
  const allowed = await get('/api/users', { headers: { Origin: siteOrigin } });
  check(
    allowed.headers.get('access-control-allow-origin') === siteOrigin,
    `CORS allows ${siteOrigin}`,
  );
  const stranger = await get('/api/users', { headers: { Origin: 'https://example.com' } });
  check(
    stranger.headers.get('access-control-allow-origin') === null,
    'CORS does not allow another origin',
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
