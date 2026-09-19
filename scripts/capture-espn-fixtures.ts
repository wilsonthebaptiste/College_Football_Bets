/**
 * Phase 1.5 — the ESPN spike.
 *
 * Captures real ESPN payloads to `apps/api/test/fixtures/espn/` so that Phase 2's
 * normalizers are written against what ESPN actually returns rather than against
 * what its undocumented API is imagined to return. The captured files are also
 * the mock provider's data source, which is what makes CI deterministic and the
 * app demoable offline.
 *
 *   node --experimental-strip-types scripts/capture-espn-fixtures.ts
 *   node --experimental-strip-types scripts/capture-espn-fixtures.ts --date 20251004
 *
 * This is a one-off developer tool, not application code. It is the one place in
 * the repo allowed to be chatty and to hard-code ESPN URLs outside
 * `apps/api/src/providers/espn/` — nothing in `src` imports it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'apps', 'api', 'test', 'fixtures', 'espn');

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football';

/**
 * ESPN sits behind Akamai, which throttles bursts from one IP with a bare 403
 * and no body. Observed repeatedly while writing this script. So: one request at
 * a time, a deliberate pause between them, and a retry with backoff. Phase 2's
 * `client.ts` needs the same posture (see docs/espn-notes.md).
 */
const PAUSE_MS = 700;
const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 15_000;
const USER_AGENT = 'college-football-bets/0.1 (personal project; fixture capture)';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FetchResult {
  ok: boolean;
  status: number;
  body: unknown;
  note: string | null;
}

async function getJson(url: string): Promise<FetchResult> {
  let lastStatus = 0;
  let lastNote: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      lastStatus = response.status;

      if (response.status === 403 || response.status === 429 || response.status >= 500) {
        lastNote = `HTTP ${String(response.status)} on attempt ${String(attempt)}`;
        await sleep(PAUSE_MS * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        // The error BODY is itself worth capturing — "no predictor for this game"
        // is a shape the normalizer has to recognize (§12).
        const body: unknown = await response.json().catch(() => null);
        return {
          ok: false,
          status: response.status,
          body,
          note: `HTTP ${String(response.status)}`,
        };
      }

      return { ok: true, status: response.status, body: await response.json(), note: null };
    } catch (error) {
      lastNote = error instanceof Error ? error.message : String(error);
      await sleep(PAUSE_MS * 2 ** attempt);
    }
  }

  return { ok: false, status: lastStatus, body: null, note: lastNote };
}

interface Capture {
  /** File name, without extension. */
  name: string;
  url: string;
  /** What this fixture is meant to demonstrate, recorded alongside the payload. */
  purpose: string;
  /** Save the response body even on a non-2xx. Used for "no predictor" (§12). */
  keepErrorBody?: boolean;
}

/**
 * Some states simply are not on today's calendar. A postponement is the obvious
 * one: there may not be a single one all season. Rather than hand-authoring a
 * guess, pull a REAL payload from a date that is known to contain it — the 2020
 * season is thick with COVID postponements. The shape is what matters, and the
 * shape is real.
 */
const KNOWN_EDGE_CASE_DATES = {
  postponed: '20201121',
} as const;

interface Manifest {
  capturedAt: string;
  entries: {
    name: string;
    url: string;
    purpose: string;
    status: number;
    ok: boolean;
    bytes: number;
    note: string | null;
  }[];
}

/**
 * Small fixtures are pretty-printed because you read them by hand while writing
 * a normalizer. Large ones are not, because you never read a 4 MB file by hand
 * and the indentation doubles what the repo has to carry.
 */
const PRETTY_PRINT_LIMIT_BYTES = 256 * 1024;

async function save(name: string, payload: unknown): Promise<number> {
  const file = join(OUT_DIR, `${name}.json`);
  const compact = JSON.stringify(payload);
  const text =
    compact.length > PRETTY_PRINT_LIMIT_BYTES ? compact : JSON.stringify(payload, null, 2);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
  return Buffer.byteLength(text, 'utf8');
}

// ─── Discovery ───────────────────────────────────────────────────────────────
// Which team is ranked, which is on a bye, which game is live — none of that is
// knowable in advance. Probe the scoreboard and rankings, then capture whatever
// the calendar happens to be offering today.

interface Discovered {
  rankedTeamId: string | null;
  unrankedTeamId: string | null;
  liveGameId: string | null;
  completedGameId: string | null;
  upcomingGameId: string | null;
  oddStatusGameId: string | null;
  oddStatusLabel: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function dig(root: unknown, path: (string | number)[]): unknown {
  let current: unknown = root;
  for (const step of path) {
    if (typeof step === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[step];
    } else {
      const record = asRecord(current);
      if (record === null) return undefined;
      current = record[step];
    }
  }
  return current;
}

function discover(scoreboard: unknown, rankings: unknown): Discovered {
  const found: Discovered = {
    rankedTeamId: null,
    unrankedTeamId: null,
    liveGameId: null,
    completedGameId: null,
    upcomingGameId: null,
    oddStatusGameId: null,
    oddStatusLabel: null,
  };

  const firstPoll = dig(rankings, ['rankings', 0]);
  const rankedId = dig(firstPoll, ['ranks', 0, 'team', 'id']);
  if (typeof rankedId === 'string') found.rankedTeamId = rankedId;
  else if (typeof rankedId === 'number') found.rankedTeamId = String(rankedId);

  const rankedIds = new Set(
    asArray(dig(firstPoll, ['ranks'])).map((rank) => String(dig(rank, ['team', 'id']))),
  );

  for (const event of asArray(dig(scoreboard, ['events']))) {
    const state = dig(event, ['status', 'type', 'state']);
    const name = dig(event, ['status', 'type', 'name']);
    const id = dig(event, ['id']);
    if (typeof id !== 'string') continue;

    if (state === 'in' && found.liveGameId === null) found.liveGameId = id;
    if (state === 'post' && found.completedGameId === null) found.completedGameId = id;
    if (state === 'pre' && found.upcomingGameId === null) found.upcomingGameId = id;

    if (
      typeof name === 'string' &&
      !['STATUS_SCHEDULED', 'STATUS_IN_PROGRESS', 'STATUS_FINAL'].includes(name) &&
      found.oddStatusGameId === null
    ) {
      found.oddStatusGameId = id;
      found.oddStatusLabel = name;
    }

    for (const competitor of asArray(dig(event, ['competitions', 0, 'competitors']))) {
      const teamId = dig(competitor, ['team', 'id']);
      if (typeof teamId === 'string' && !rankedIds.has(teamId) && found.unrankedTeamId === null) {
        found.unrankedTeamId = teamId;
      }
    }
  }

  return found;
}

/** `?dates=` wants YYYYMMDD. All date reasoning in this project is UTC (§20). */
function yyyymmdd(date: Date): string {
  const y = String(date.getUTCFullYear());
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function parseDateArg(argv: string[]): string | null {
  const index = argv.indexOf('--date');
  if (index === -1) return null;
  const value = argv[index + 1];
  return value !== undefined && /^\d{8}$/.test(value) ? value : null;
}

async function main(): Promise<void> {
  const dateArg = parseDateArg(process.argv);
  const scoreboardDate = dateArg ?? yyyymmdd(new Date());

  console.log(`Capturing ESPN fixtures for ${scoreboardDate} → ${OUT_DIR}\n`);

  const manifest: Manifest = { capturedAt: new Date().toISOString(), entries: [] };

  const run = async (capture: Capture): Promise<unknown> => {
    process.stdout.write(`  ${capture.name.padEnd(30)} `);
    const result = await getJson(capture.url);
    const shouldSave = result.ok || (capture.keepErrorBody === true && result.body !== null);
    const bytes = shouldSave ? await save(capture.name, result.body) : 0;

    manifest.entries.push({
      name: capture.name,
      url: capture.url,
      purpose: capture.purpose,
      status: result.status,
      ok: shouldSave,
      bytes,
      note: result.ok ? null : result.note,
    });

    console.log(
      shouldSave
        ? `ok   ${String(bytes).padStart(8)} bytes${result.ok ? '' : `  (HTTP ${String(result.status)}, body kept)`}`
        : `FAIL ${result.note ?? ''}`,
    );
    await sleep(PAUSE_MS);
    return result.body;
  };

  // ── Always available ──────────────────────────────────────────────────────
  const teamList = await run({
    name: 'team-list',
    url: `${SITE}/teams?limit=900`,
    purpose: 'Full team list — source for admin team search, cached 24h (§43).',
  });

  const rankings = await run({
    name: 'rankings',
    url: `${SITE}/rankings`,
    purpose: 'Rankings feed. Confirms poll names and whether CFP is published (§7).',
  });

  const scoreboard = await run({
    name: `scoreboard-${scoreboardDate}`,
    url: `${SITE}/scoreboard?dates=${scoreboardDate}&groups=80`,
    purpose: "One day's slate. Source of live/final/odd-status game ids (§11, §18).",
  });

  const calendar = await run({
    name: 'calendar',
    url: `${SITE}/scoreboard`,
    purpose: 'Bare scoreboard — carries the season/week calendar used by §21.',
  });

  // ── Discovered ────────────────────────────────────────────────────────────
  const found = discover(scoreboard, rankings);
  console.log('\nDiscovered from the slate:');
  console.log(JSON.stringify(found, null, 2));
  console.log('');

  const teamCaptures: Capture[] = [];

  if (found.rankedTeamId !== null) {
    teamCaptures.push(
      {
        name: 'team-ranked',
        url: `${SITE}/teams/${found.rankedTeamId}`,
        purpose: 'A ranked team: rank + record field paths (§7, §8).',
      },
      {
        name: 'schedule-ranked',
        url: `${SITE}/teams/${found.rankedTeamId}/schedule`,
        purpose: 'Full-season schedule for a ranked team (§17).',
      },
    );
  }
  if (found.unrankedTeamId !== null) {
    teamCaptures.push(
      {
        name: 'team-unranked',
        url: `${SITE}/teams/${found.unrankedTeamId}`,
        purpose: 'An unranked team — must normalize to `unranked`, not `unavailable` (§7).',
      },
      {
        name: 'schedule-unranked',
        url: `${SITE}/teams/${found.unrankedTeamId}/schedule`,
        purpose: 'Schedule with gaps in the week sequence — the bye-week source (§10, §22).',
      },
    );
  }

  for (const capture of teamCaptures) {
    await run(capture);
  }

  const gameCaptures: Capture[] = [];
  const pushGame = (id: string | null, name: string, purpose: string): void => {
    if (id !== null) gameCaptures.push({ name, url: `${SITE}/summary?event=${id}`, purpose });
  };
  pushGame(found.liveGameId, 'game-live', 'Live game: period, clock, status detail (§11).');
  pushGame(found.completedGameId, 'game-final', 'Completed game: result and final score (§9).');
  pushGame(
    found.upcomingGameId,
    'game-upcoming',
    'Scheduled game: kickoff, broadcast, no score (§10).',
  );
  pushGame(
    found.oddStatusGameId,
    'game-odd-status',
    `Non-standard status (${found.oddStatusLabel ?? 'unknown'}) — postponed/canceled/delayed (§18).`,
  );

  for (const capture of gameCaptures) {
    await run(capture);
  }

  // ── Conference names (§6, §16) ────────────────────────────────────────────
  // Neither /teams/{id} nor the team list carries a conference NAME — only a
  // numeric group id. Resolving it is a two-hop through the core API, and both
  // hops are captured so Phase 2 can build the id→name map offline.
  const seasonYear = dig(calendar, ['season', 'year']);
  if (typeof seasonYear === 'number') {
    const groupsBase = `${CORE}/seasons/${String(seasonYear)}/types/2/groups`;
    await run({
      name: 'conferences-index',
      url: `${groupsBase}/80/children?limit=100`,
      purpose: 'FBS conference group ids ($ref list). Hop 1 of conference-name resolution.',
    });
    await run({
      name: 'conference-single',
      url: `${groupsBase}/8`,
      purpose: 'One resolved conference (name, shortName, logo). Hop 2.',
    });
    await run({
      name: 'conference-teams',
      url: `${groupsBase}/8/teams?limit=200`,
      purpose: "One conference's member teams ($ref list). Hop 3: team id -> conference.",
    });
  }

  // ── Predictor: the endpoint most likely to be missing ─────────────────────
  const predictorTarget = found.upcomingGameId ?? found.liveGameId ?? found.completedGameId;
  if (predictorTarget !== null) {
    await run({
      name: 'prediction-present',
      url: `${CORE}/events/${predictorTarget}/competitions/${predictorTarget}/predictor`,
      purpose: 'Matchup predictor when ESPN publishes one (§12).',
    });
  }
  await run({
    name: 'prediction-absent',
    url: `${CORE}/events/1/competitions/1/predictor`,
    purpose:
      'The 404 body for a game with no predictor — must normalize to `null`, never 0% (§12, §46).',
    keepErrorBody: true,
  });

  // ── Edge-case states the current calendar cannot supply ───────────────────
  if (found.upcomingGameId === null) {
    // Capturing a past date, or a midweek one after that day's games finished.
    // Walk forward until a slate with a scheduled game turns up.
    console.log('\nNo scheduled game on this slate; looking ahead for one.');
    const base = new Date(
      Date.UTC(
        Number(scoreboardDate.slice(0, 4)),
        Number(scoreboardDate.slice(4, 6)) - 1,
        Number(scoreboardDate.slice(6, 8)),
      ),
    );

    for (let offset = 1; offset <= 7; offset += 1) {
      const ahead = new Date(base.getTime() + offset * 24 * 60 * 60 * 1000);
      const slate = await getJson(`${SITE}/scoreboard?dates=${yyyymmdd(ahead)}&groups=80`);
      await sleep(PAUSE_MS);
      if (!slate.ok) continue;

      const upcoming = asArray(dig(slate.body, ['events']))
        .filter((event) => dig(event, ['status', 'type', 'state']) === 'pre')
        .map((event) => dig(event, ['id']))
        .find((id): id is string => typeof id === 'string');

      if (upcoming !== undefined) {
        await run({
          name: 'game-upcoming',
          url: `${SITE}/summary?event=${upcoming}`,
          purpose: 'Scheduled game: kickoff, broadcast, null scores (§10).',
        });
        break;
      }
    }
  }

  if (found.oddStatusGameId === null) {
    console.log('\nNo non-standard status on this slate; pulling a real one from a known date.');
    const historical = await run({
      name: 'scoreboard-postponed-slate',
      url: `${SITE}/scoreboard?dates=${KNOWN_EDGE_CASE_DATES.postponed}&groups=80`,
      purpose: `Real STATUS_POSTPONED games (${KNOWN_EDGE_CASE_DATES.postponed}) — §18, §50.`,
    });
    const postponedId = asArray(dig(historical, ['events']))
      .map((event) => ({ id: dig(event, ['id']), name: dig(event, ['status', 'type', 'name']) }))
      .find((entry) => entry.name === 'STATUS_POSTPONED')?.id;
    if (typeof postponedId === 'string') {
      await run({
        name: 'game-postponed',
        url: `${SITE}/summary?event=${postponedId}`,
        purpose: 'A genuinely postponed game. Note state="post" with completed=false (§18).',
      });
    }
  }

  if (found.liveGameId === null) {
    await synthesizeLiveFixture(manifest);
  }

  await save('_manifest', manifest);

  const failures = manifest.entries.filter((entry) => !entry.ok);
  console.log(
    `\n${String(manifest.entries.length - failures.length)} captured, ${String(failures.length)} failed.`,
  );
  for (const failure of failures) {
    console.log(`  ${failure.name}: ${failure.note ?? `HTTP ${String(failure.status)}`}`);
  }

  const teamCount = asArray(dig(teamList, ['sports', 0, 'leagues', 0, 'teams'])).length;
  console.log(`\nTeam list holds ${String(teamCount)} teams.`);

  await reportByeWeeks();
}

/**
 * A live game exists for roughly four hours a week, and only on game weekends.
 * When the capture run does not land in one, derive the fixture from a real
 * completed game by rewinding its status to mid-third-quarter.
 *
 * Marked `_synthetic` so nobody mistakes it for a capture, and so it can be
 * replaced by a real one: re-run this script on a Saturday afternoon and the
 * real payload overwrites it.
 */
async function synthesizeLiveFixture(manifest: Manifest): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  let final: unknown;
  try {
    final = JSON.parse(await readFile(join(OUT_DIR, 'game-final.json'), 'utf8'));
  } catch {
    console.log('\nNo game-final.json to derive a live fixture from; skipping.');
    return;
  }

  const clone = JSON.parse(JSON.stringify(final)) as Record<string, unknown>;
  const competition = dig(clone, ['header', 'competitions', 0]);
  const competitionRecord = asRecord(competition);
  if (competitionRecord === null) {
    console.log('\nUnexpected summary shape; skipping the synthetic live fixture.');
    return;
  }

  // Exactly the vocabulary observed in a real in-progress payload.
  competitionRecord['status'] = {
    clock: 272,
    displayClock: '4:32',
    period: 3,
    type: {
      id: '2',
      name: 'STATUS_IN_PROGRESS',
      state: 'in',
      completed: false,
      description: 'In Progress',
      detail: '4:32 - 3rd Quarter',
      shortDetail: '4:32 - 3rd',
    },
  };
  for (const competitor of asArray(competitionRecord['competitors'])) {
    const record = asRecord(competitor);
    if (record === null) continue;
    // A live game has no winner. Leaving `winner: true` in place is exactly the
    // §11 failure — a game shown as decided before the provider says so.
    delete record['winner'];
  }

  clone['_synthetic'] = true;
  clone['_syntheticNote'] =
    "Derived from game-final.json by rewinding the status to STATUS_IN_PROGRESS. Status vocabulary is real; scores are a completed game's. Re-run scripts/capture-espn-fixtures.ts during a live Saturday game to replace it with a genuine capture.";

  const bytes = await save('game-live', clone);
  manifest.entries.push({
    name: 'game-live',
    url: '(synthesized from game-final)',
    purpose: 'Live game: period, clock, no winner (§11). SYNTHETIC.',
    status: 0,
    ok: true,
    bytes,
    note: 'synthetic',
  });
  console.log(`  ${'game-live'.padEnd(30)} ok   ${String(bytes).padStart(8)} bytes  (SYNTHETIC)`);
}

/** Bye weeks are gaps in the week sequence, not rows (§10). Report what we captured. */
async function reportByeWeeks(): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  console.log('');
  for (const name of ['schedule-ranked', 'schedule-unranked']) {
    try {
      const schedule: unknown = JSON.parse(await readFile(join(OUT_DIR, `${name}.json`), 'utf8'));
      const weeks = asArray(dig(schedule, ['events']))
        .map((event) => dig(event, ['week', 'number']))
        .filter((week): week is number => typeof week === 'number');
      if (weeks.length === 0) continue;

      const highest = Math.max(...weeks);
      const missing: number[] = [];
      for (let week = 1; week <= highest; week += 1) {
        if (!weeks.includes(week)) missing.push(week);
      }
      console.log(
        `${name}: weeks ${weeks.join(',')} — bye week(s): ${missing.length > 0 ? missing.join(',') : 'none'}`,
      );
    } catch {
      // Fixture absent; nothing to report.
    }
  }
}

await main();
