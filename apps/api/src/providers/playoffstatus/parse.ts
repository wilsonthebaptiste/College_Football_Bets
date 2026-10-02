import type { ConferenceOddsPage, ConferenceOddsRow } from '../types';

/**
 * playoffstatus.com's conference pages → rows of odds (§40, applied to HTML).
 *
 * Like `providers/espn/validate.ts`, every function here is TOTAL: whatever it
 * is given — a redesigned page, a truncated download, an error document, an
 * empty string — it returns a value, never a throw. Whether that value is
 * usable is the caller's question, and `parseConferencePage` answers it with a
 * row count and two column sums rather than with an exception.
 *
 * HTML cannot be validated the way JSON can, so those numbers ARE the
 * validation. The whole redesign warning consists of three things: the row
 * count, the column sums, and the two-way join in `services/projection.ts`.
 *
 * ## Three traps, in the order they bit
 *
 * 1. **A single regex over the whole table silently dropped one row per page**
 *    (SEC 15 of 16, Big Ten 17 of 18). Rows and cells are walked separately
 *    here for that reason, and the row count is checked by the caller rather
 *    than trusted.
 * 2. **The team cell holds two spellings**, a wide one and a narrow one for
 *    small screens, so stripping tags yields `Mississippi St.Miss. St.`. The
 *    `span.wide` is read when present, else the anchor's own text.
 * 3. **Entities must be decoded before anything else**: `Texas A&amp;M`,
 *    `&lt;1%`, and the `&#160;` that separates the words of the page's stamp.
 */

// ─── Entities ────────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;

/** Named and numeric character references. An unknown one is left alone. */
export function decodeEntities(value: string): string {
  return value.replace(ENTITY, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeChar(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeChar(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function safeChar(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Tags out, entities decoded, every run of whitespace (including `&nbsp;`) one space. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/gu, ' ')
    .trim();
}

// ─── Cells ───────────────────────────────────────────────────────────────────

const TABLE = /<table[^>]*>([\s\S]*?)<\/table>/i;
const ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL = /<td([^>]*)>([\s\S]*?)<\/td>/gi;
const TEAM_CELL_CLASS = /\bclass\s*=\s*["']?[^"'>]*\btblteam\b/i;
const WIDE_SPAN = /<span[^>]*\bclass\s*=\s*["']?[^"'>]*\bwide\b[^>]*>([\s\S]*?)<\/span>/i;
const ANCHOR = /<a[^>]*>([\s\S]*?)<\/a>/i;

/**
 * The published team name, from the cell that carries it.
 *
 * Preference order is deliberate: the wide spelling is the full one
 * ("Mississippi St." rather than "Miss. St."), and the anchor's text is the
 * whole cell minus any stray markup. Falling through to the cell's own text
 * would concatenate the two spellings, which is trap 2.
 */
export function readTeamName(cellHtml: string): string | null {
  const wide = WIDE_SPAN.exec(cellHtml)?.[1];
  if (wide !== undefined) {
    const name = textOf(wide);
    if (name !== '') return name;
  }
  const anchor = ANCHOR.exec(cellHtml)?.[1];
  if (anchor !== undefined) {
    const name = textOf(anchor);
    if (name !== '') return name;
  }
  const bare = textOf(cellHtml);
  return bare === '' ? null : bare;
}

/** `<1%` is published for anything below one percent; it is read as a half. */
export const BELOW_ONE_PERCENT = 0.5;

const PERCENT = /^(-?\d+(?:\.\d+)?)\s*%$/;
const BELOW_ONE = /^<\s*1\s*%$/;

/**
 * One percentage cell, as a percentage (not yet a probability).
 *
 * `null` for anything that is not a published figure, which the caller turns
 * into a dropped row rather than a zero: a cell we could not read says nothing
 * about a team's chances.
 */
export function readPercent(cellHtml: string): number | null {
  const value = textOf(cellHtml);
  if (BELOW_ONE.test(value)) return BELOW_ONE_PERCENT;
  const match = PERCENT.exec(value);
  if (match === null) return null;
  const percent = Number(match[1]);
  // A percentage outside 0–100 is not this publisher's rounding; it is a
  // column that no longer means what it did.
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
}

// ─── The page ────────────────────────────────────────────────────────────────

/**
 * The page's own stamp: `<div class="datetime">Sat Sep&#160;26 11:30&#160;pm</div>`.
 *
 * Kept verbatim as a string and never parsed. It has no year and no timezone,
 * so turning it into an instant would mean inventing a zone, and the whole
 * point of carrying it is that it is the publisher's statement rather than
 * ours (§39).
 */
const DATETIME_DIV = /<div[^>]*\bclass\s*=\s*["']?[^"'>]*\bdatetime\b[^>]*>([\s\S]*?)<\/div>/i;

export function readComputedLabel(html: string): string | null {
  const raw = DATETIME_DIV.exec(html)?.[1];
  if (raw === undefined) return null;
  const label = textOf(raw);
  return label === '' ? null : label;
}

/** Columns, left to right: team, W, L, champions, championship-game participant. */
const CHAMPION_CELL = 3;
const PARTICIPATE_CELL = 4;

export interface ParsedConferencePage {
  rows: ConferenceOddsRow[];
  page: ConferenceOddsPage;
  /**
   * Rows that carried a team cell but no readable pair of percentages. Non-zero
   * means the table's shape moved, and the column sums will say so too.
   */
  droppedRows: number;
}

/**
 * One conference page.
 *
 * Rows are identified by their team cell (`td.tblteam`), which is what
 * distinguishes a team row from the page's two header rows without depending
 * on how many header rows there happen to be.
 */
export function parseConferencePage(html: string, conference: string): ParsedConferencePage {
  const table = TABLE.exec(html)?.[1] ?? '';
  const rows: ConferenceOddsRow[] = [];
  let droppedRows = 0;

  ROW.lastIndex = 0;
  for (const rowMatch of table.matchAll(ROW)) {
    const rowHtml = rowMatch[1] ?? '';
    const cells = [...rowHtml.matchAll(CELL)];
    const teamCell = cells[0];
    if (teamCell === undefined || !TEAM_CELL_CLASS.test(teamCell[1] ?? '')) continue;

    const teamName = readTeamName(teamCell[2] ?? '');
    const champion = readPercent(cells[CHAMPION_CELL]?.[2] ?? '');
    const participate = readPercent(cells[PARTICIPATE_CELL]?.[2] ?? '');
    if (teamName === null || champion === null || participate === null) {
      droppedRows += 1;
      continue;
    }

    rows.push({
      teamName,
      conference,
      // Probabilities, from here on. The types say 0–1 throughout.
      winConference: champion / 100,
      reachConferenceGame: participate / 100,
    });
  }

  return {
    rows,
    page: {
      conference,
      computedLabel: readComputedLabel(html),
      rows: rows.length,
      championPercent: rows.reduce((total, row) => total + row.winConference * 100, 0),
      participatePercent: rows.reduce((total, row) => total + row.reachConferenceGame * 100, 0),
    },
    droppedRows,
  };
}
