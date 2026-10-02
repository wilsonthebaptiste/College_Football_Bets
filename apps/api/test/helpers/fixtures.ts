import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Phase 1 ESPN captures (docs/espn-notes.md §9). Read-only: tests clone before mutating. */
export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'espn');

const memo = new Map<string, string>();

function text(name: string): string {
  let cached = memo.get(name);
  if (cached === undefined) {
    cached = readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8');
    memo.set(name, cached);
  }
  return cached;
}

/** A fresh parse every call, so a test can mutate the result freely. */
export function fixture(name: string): unknown {
  return JSON.parse(text(name)) as unknown;
}

export function fixtureText(name: string): string {
  return text(name);
}

/** Every payload fixture (the manifest is metadata, not a payload). */
export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith('.json') && !file.startsWith('_'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

/** When the fixtures were captured: the moment their "now" belongs to. */
export const CAPTURED_AT = '2026-09-18T04:33:10.967Z';

// ─── playoffstatus.com (projected points, Phase 2) ───────────────────────────

/**
 * The four conference pages, plus the ESPN conference map captured the same
 * day so the two-way join can be asserted against real membership.
 *
 * Captured separately from the ESPN payloads, and later: `fpi.json` sits with
 * the other ESPN captures because it IS one, but these are HTML from a
 * different publisher and their own manifest records their own date.
 */
export const PLAYOFFSTATUS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'playoffstatus',
);

/** The capture date of the playoffstatus pages and the conference map. */
export const ODDS_CAPTURED_AT = '2026-10-01';

/** The four pages, as captured. The key is the conference's ESPN short name. */
export const CONFERENCE_FIXTURES: Readonly<Record<string, string>> = {
  SEC: 'sec',
  'Big Ten': 'big-ten',
  'Big 12': 'big-12',
  ACC: 'acc',
};

export function conferencePageFixture(conference: string): string {
  const file = CONFERENCE_FIXTURES[conference];
  if (file === undefined) throw new Error(`no captured page for ${conference}`);
  return readFileSync(join(PLAYOFFSTATUS_DIR, `${file}.html`), 'utf8');
}

/** Provider team id → conference short name, as `getConferences` returns it. */
export function conferenceMapFixture(): Record<string, string> {
  return JSON.parse(readFileSync(join(PLAYOFFSTATUS_DIR, 'conference-map.json'), 'utf8')) as Record<
    string,
    string
  >;
}
