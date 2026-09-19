/**
 * §21 — "The season should not be permanently hard-coded to one year."
 *
 * The rule is easy to state and easy to break by accident: someone debugging a
 * schedule types `2026` into a comparison, it works all autumn, and the
 * application quietly stops being correct the following August.
 *
 * So the rule is enforced rather than remembered. Any four-digit year literal in
 * application source fails the build unless it is in the one module allowed to
 * know what year it is, a test, or a captured fixture.
 *
 *   node scripts/check-season-literals.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const ROOTS = ['packages', 'apps'];

/** Files that are allowed to contain a year. Each exemption is a decision. */
const ALLOWED = [
  // The centralized season module — pinned down by its own tests.
  'packages/shared/src/season.ts',
];

const ALLOWED_PATTERNS = [
  /\.test\.tsx?$/, // tests must be able to say "January 2026"
  /[/\\]test[/\\]/, // fixtures and test helpers
  /[/\\]fixtures[/\\]/,
  /[/\\]node_modules[/\\]/,
  /[/\\]dist[/\\]/,
];

const YEAR = /\b(19|20)\d{2}\b/g;

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      yield path;
    }
  }
}

function isExempt(posixPath) {
  return ALLOWED.includes(posixPath) || ALLOWED_PATTERNS.some((pattern) => pattern.test(posixPath));
}

const violations = [];

for (const root of ROOTS) {
  for await (const file of walk(root)) {
    const posixPath = relative(process.cwd(), file).split(sep).join('/');
    // Only application source, not config or build output.
    if (!posixPath.includes('/src/') && !posixPath.includes('/test/')) continue;
    if (isExempt(posixPath)) continue;

    const text = await readFile(file, 'utf8');
    text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(YEAR)) {
        violations.push({ file: posixPath, line: index + 1, year: match[0], text: line.trim() });
      }
    });
  }
}

if (violations.length === 0) {
  console.log('✓ No hard-coded year literals outside packages/shared/src/season.ts');
  process.exit(0);
}

console.error(`✗ ${violations.length} hard-coded year literal(s) found.\n`);
console.error('The season must resolve through packages/shared/src/season.ts (§21).');
console.error('If this literal is genuinely unavoidable, add the file to ALLOWED in');
console.error('scripts/check-season-literals.mjs — and say why in a comment there.\n');
for (const violation of violations) {
  console.error(`  ${violation.file}:${violation.line}  "${violation.year}"`);
  console.error(`      ${violation.text}`);
}
process.exit(1);
