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
