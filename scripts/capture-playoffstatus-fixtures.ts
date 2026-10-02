/**
 * Captures the conference-odds fixtures for projected points.
 *
 *   node --experimental-strip-types scripts/capture-playoffstatus-fixtures.ts
 *
 * Two different things, captured together because the test that matters needs
 * both on the same day:
 *
 *   1. playoffstatus.com's four power-four pages, as HTML. These are the only
 *      source of a conference RUNNER-UP probability, which is half of the
 *      rubric's conference lines.
 *   2. ESPN's conference map, exactly as `getConferences()` returns it. The
 *      two-way join — every scraped row matched a team, every power-four team
 *      had a row — cannot be asserted against real membership without it.
 *
 * `robots.txt` on playoffstatus.com is `User-agent: * / Disallow:`, so this is
 * permitted; it is four requests, run by hand. The running Worker reads the
 * same pages at most four times a day behind a 6 h cache.
 *
 * A one-off developer tool, like its ESPN sibling: nothing in `src` imports it,
 * and it is one of the two places allowed to hard-code these URLs outside
 * `apps/api/src/providers/`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'apps', 'api', 'test', 'fixtures', 'playoffstatus');

const ORIGIN = 'https://www.playoffstatus.com';
const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football';

/** Courtesy, and ESPN's CDN wants a common HTTP-library prefix anyway (espn-notes §1). */
const USER_AGENT = 'curl/8.9.1 college-football-bets/0.5 (personal project; fixture capture)';
const PAUSE_MS = 700;
const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 20_000;

/** ESPN's group id for FBS, the parent of every FBS conference. */
const FBS_GROUP = '80';

const PAGES = [
  { file: 'sec', conference: 'SEC', path: '/secfootball/secfootballpostseasonprob.html' },
  // `big10`, not `bigten`: `bigten` is a 404.
  {
    file: 'big-ten',
    conference: 'Big Ten',
    path: '/big10football/big10footballpostseasonprob.html',
  },
  { file: 'big-12', conference: 'Big 12', path: '/big12football/big12footballpostseasonprob.html' },
  { file: 'acc', conference: 'ACC', path: '/accfootball/accfootballpostseasonprob.html' },
] as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function get(url: string, accept: string): Promise<string> {
  let last = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return await response.text();
      last = `HTTP ${String(response.status)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(PAUSE_MS * 2 ** attempt);
  }
  throw new Error(`${url}: ${last}`);
}

function refId(href: unknown, kind: 'groups' | 'teams'): string | null {
  if (typeof href !== 'string') return null;
  return new RegExp(`/${kind}/([A-Za-z0-9_-]{1,40})(?:[/?#]|$)`).exec(href)?.[1] ?? null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** The season the map belongs to, from ESPN's own calendar. Never a literal (§21). */
async function currentSeasonYear(): Promise<number> {
  const body: unknown = JSON.parse(
    await get(
      'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard',
      'application/json',
    ),
  );
  const year = asRecord(asRecord(body)['season'])['year'];
  if (typeof year !== 'number') throw new Error('ESPN calendar carried no season year');
  return year;
}

/** Exactly what `EspnProvider.getConferences()` builds, by the same two hops. */
async function captureConferenceMap(year: number): Promise<Record<string, string>> {
  const base = `${CORE}/seasons/${String(year)}/types/2/groups`;
  const children: unknown = JSON.parse(
    await get(`${base}/${FBS_GROUP}/children?limit=100`, 'application/json'),
  );
  const groupIds = asArray(asRecord(children)['items'])
    .map((item) => refId(asRecord(item)['$ref'], 'groups'))
    .filter((id): id is string => id !== null);

  const map: Record<string, string> = {};
  for (const groupId of groupIds) {
    const detail = asRecord(JSON.parse(await get(`${base}/${groupId}`, 'application/json')));
    await sleep(PAUSE_MS);
    const members = asRecord(
      JSON.parse(await get(`${base}/${groupId}/teams?limit=200`, 'application/json')),
    );
    await sleep(PAUSE_MS);

    const label = detail['shortName'] ?? detail['name'];
    if (typeof label !== 'string') continue;
    const teamIds = asArray(members['items'])
      .map((item) => refId(asRecord(item)['$ref'], 'teams'))
      .filter((id): id is string => id !== null);
    for (const teamId of teamIds) map[teamId] = label;
    console.log(`  ${label.padEnd(16)} ${String(teamIds.length).padStart(3)} teams`);
  }
  return map;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`Capturing conference odds → ${OUT_DIR}\n`);

  const robots = await get(`${ORIGIN}/robots.txt`, 'text/plain');
  console.log(`robots.txt:\n${robots.trim()}\n`);
  await sleep(PAUSE_MS);

  for (const page of PAGES) {
    const html = await get(`${ORIGIN}${page.path}`, 'text/html');
    await writeFile(join(OUT_DIR, `${page.file}.html`), html, 'utf8');
    // Enough of a read to see that the capture is not an error page. The real
    // parse, with its row count and column sums, is in the test suite.
    const rows = (html.match(/tblteam/g) ?? []).length;
    const stamp = /<div[^>]*class="datetime"[^>]*>([\s\S]*?)<\/div>/i
      .exec(html)?.[1]
      ?.replace(/<[^>]*>/g, ' ')
      .replace(/&#160;|&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    console.log(
      `  ${page.conference.padEnd(8)} ${String(html.length).padStart(7)} bytes, ` +
        `${String(rows).padStart(2)} rows, stamped "${stamp ?? '?'}"`,
    );
    await sleep(PAUSE_MS);
  }

  console.log('\nESPN conference map (the other half of the two-way join):');
  const year = await currentSeasonYear();
  const map = await captureConferenceMap(year);
  await writeFile(
    join(OUT_DIR, 'conference-map.json'),
    `${JSON.stringify(map, null, 2)}\n`,
    'utf8',
  );
  console.log(`\n${String(Object.keys(map).length)} teams mapped.`);
  console.log('\nUpdate _manifest.json with today’s date, the row counts, and the stamps.');
}

await main();
