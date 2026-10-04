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

// ── The pick index ──────────────────────────────────────────────────────────
// Self-consistent whatever boards the project holds: every name it gives is a
// board that exists. It reads only our own Postgres, so it must answer even
// when the sports provider cannot.
const index = await get('/api/selections');
const owners = index.body?.owners ?? {};
const ids = new Set(list.map((user) => user.id));
const named = Object.values(owners).flat();
check(
  index.status === 200 && typeof owners === 'object',
  'GET /api/selections with no token',
  `${Object.keys(owners).length} teams picked, ${index.ms} ms`,
);
check(
  /public, max-age=\d+/.test(index.headers.get('cache-control') ?? ''),
  '  cacheable',
  index.headers.get('cache-control') ?? '',
);
check(
  named.length > 0 && named.every((person) => ids.has(person.userId)),
  '  every name in it is a board that exists',
  `${named.length} picks by ${String(new Set(named.map((p) => p.userId)).size)} people`,
);

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

  // The index and the board are two readings of the same rows. Every team on
  // screen must be findable in the index, with this board's owner among the
  // names, or a search for it would say nobody has it.
  const listed = teams.filter((entry) =>
    (owners[entry.team?.providerTeamId] ?? []).some((person) => person.userId === owner.id),
  ).length;
  check(
    teams.length > 0 && listed === teams.length,
    `  every team on this board is in the index, under ${owner.displayName}`,
    `${listed} of ${teams.length}`,
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

// ── Projected points ────────────────────────────────────────────────────────
// Two things only this can check: that the leaderboard names the same boards
// `/api/users` does, and that a breakdown's own numbers add up. The rubric's
// arithmetic is pinned by the test suite against real teams; what is at stake
// here is whether the deployed Worker reaches both publishers at all.
const projections = await get('/api/projections');
const boards = projections.body?.boards ?? [];
check(
  projections.status === 200 && boards.length === list.length,
  'GET /api/projections with no token',
  `${boards.length} boards, ${projections.ms} ms`,
);
check(
  boards.every((board) => ids.has(board.userId)),
  '  every board on it is a board that exists',
);
const withTotal = boards.filter((board) => board.total !== null);
check(
  withTotal.length > 0,
  '  at least one board has a projected total',
  withTotal
    .slice(0, 3)
    .map((board) => `${board.displayName} ${board.total.display}`)
    .join(', '),
);
for (const source of projections.body?.sources ?? []) {
  const stamp = source.computedLabel ?? source.pages?.[0]?.computedLabel ?? 'none';
  const label = source.source === null ? '' : ` (${source.source})`;
  const reference = source.error?.requestId ? `, reference ${source.error.requestId}` : '';
  console.log(
    `      ${source.input}${label}: ${source.freshness.state}, as of ${stamp}${reference}`,
  );
}

const projected = withTotal[0] ?? boards[0];
if (projected !== undefined) {
  const breakdown = await get(`/api/users/${projected.userId}/projection`);
  const entries = breakdown.body?.teams ?? [];
  check(
    breakdown.status === 200 && entries.length > 0,
    `GET projection of ${projected.displayName}`,
    `${entries.length} teams, ${breakdown.ms} ms`,
  );

  // Each team's rubric lines sum to its own total, and the counted teams' totals
  // sum to the board's. Unrounded on both sides: the 2-dp strings are allowed to
  // disagree by a cent, which is exactly why the unrounded value is shipped too.
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const linesAddUp = entries.every(
    (entry) =>
      entry.projection.total === null ||
      near(
        entry.projection.total.value,
        entry.projection.terms.reduce((sum, term) => sum + (term.contribution?.value ?? 0), 0),
      ),
  );
  check(linesAddUp, '  every team’s rubric lines sum to its total');

  const teamTotals = entries.reduce((sum, entry) => sum + (entry.projection.total?.value ?? 0), 0);
  const board = breakdown.body?.board;
  check(
    board?.total === null ? teamTotals === 0 : near(board.total.value, teamTotals),
    '  the teams sum to the board’s total',
    board?.total === null
      ? 'no total'
      : `${board.total.display} over ${board.teamsCounted} of ${board.teamsTotal} teams`,
  );
  // A projection is never a result, so nothing it answers may be a confident
  // zero: a team nobody publishes about has no total, not 0.00.
  check(
    entries.every(
      (entry) => entry.projection.total !== null || entry.projection.complete === false,
    ),
    '  a team with no total is incomplete, not a zero',
  );
  check(
    /max-age|no-store/.test(breakdown.headers.get('cache-control') ?? ''),
    '  Cache-Control set',
    breakdown.headers.get('cache-control') ?? '',
  );
  // The one number this application models is labelled as ours, in every mode:
  // the finish line must never wear a publisher's name (§46). This is the label
  // Phase 3 found wearing ESPN's, and mock mode alone could not have shown it.
  const finishSources = new Set(
    entries
      .flatMap((entry) => entry.projection.terms)
      .filter((term) => term.kind === 'final_ranking' && term.source !== null)
      .map((term) => term.source),
  );
  check(
    [...finishSources].every((source) =>
      ['espn_poll_estimate', 'mock_projection'].includes(source),
    ),
    '  the Top-25 line is labelled as our estimate, never a publisher’s',
    [...finishSources].join(', ') || 'no finish line known',
  );

  // The team page's own read (Phase 4), by the provider's id: no database
  // request on that path, and the same total the board's breakdown gives.
  const first = entries.find((entry) => entry.projection.total !== null) ?? entries[0];
  if (first !== undefined) {
    const providerId = first.team.providerTeamId;
    const single = await get(`/api/teams/${providerId}/projection`);
    check(
      single.status === 200 && single.body?.projection?.terms?.length === 6,
      `GET /api/teams/${providerId}/projection`,
      `${single.body?.team?.name ?? '?'}, ${single.ms} ms`,
    );
    check(
      single.body?.projection?.total?.display === first.projection.total?.display,
      '  the same total the board’s breakdown gives',
      `${single.body?.projection?.total?.display ?? 'none'} and ${first.projection.total?.display ?? 'none'}`,
    );
  }
}

// ── The matchup board and the game page (plan-matchup-board, Phases 1–3) ────
const board = await get('/api/matchups');
const rows = board.body?.matchups ?? [];
check(
  board.status === 200 && (board.body?.week !== null || board.body?.notice !== null),
  'GET /api/matchups',
  `${board.body?.weeks?.find((w) => w.week === board.body?.week)?.label ?? board.body?.notice ?? '?'}: ${rows.length} matchups, ${board.ms} ms`,
);
check(
  rows.every((row) => row.home.owners.length > 0 && row.away.owners.length > 0),
  '  every row has an owner on both sides',
);
check(
  rows.every((row) => row.status === 'live' || row.situation === null),
  '  only live rows carry a down-and-distance line',
);
const game =
  rows.find((row) => row.status === 'live') ??
  rows.find((row) => row.status === 'final') ??
  rows[0];
if (game !== undefined) {
  const id = game.providerGameId;
  const single = await get(`/api/matchups/${id}`);
  check(
    single.status === 200 && single.body?.matchup?.providerGameId === id,
    `GET /api/matchups/${id}`,
    `${single.body?.matchup?.away?.team?.name ?? '?'} at ${single.body?.matchup?.home?.team?.name ?? '?'}, ${single.body?.matchup?.status ?? '?'}, ${single.ms} ms`,
  );
  const detail = await get(`/api/games/${id}/detail`);
  const inside = detail.body?.detail?.data;
  check(
    detail.status === 200 && inside !== undefined,
    `GET /api/games/${id}/detail`,
    inside === null
      ? `unavailable (${detail.body?.detail?.error?.requestId ?? 'no reference'})`
      : `${inside?.statsKind ?? '?'}, ${inside?.teamStats?.length ?? 0} stat rows, ${inside?.scoringPlays?.length ?? 0} scoring plays, ${detail.ms} ms`,
  );
  if (inside) {
    check(
      inside.status !== 'final' || inside.winProbability === null,
      '  a final game carries no win probability',
    );
    check(
      inside.statsKind === 'game' ||
        inside.teamStats.every((row) => !['firstDowns', 'totalYards'].includes(row.key)),
      '  season averages never in a game column',
    );
    const wp = inside.winProbability;
    check(
      wp === null ||
        (wp.homeWinProbability >= 0 && wp.homeWinProbability <= 1 && wp.sourceLabel !== ''),
      '  a win probability, when there is one, is 0–1 and labelled',
      wp === null ? 'none' : `${wp.sourceLabel}: home ${wp.homeWinProbability}`,
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
