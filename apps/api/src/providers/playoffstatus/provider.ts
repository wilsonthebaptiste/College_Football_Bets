import type { Season } from '@cfb/shared';
import type {
  ConferenceOddsDocument,
  ConferenceOddsPage,
  ConferenceOddsProvider,
  ConferenceOddsRow,
} from '../types';
import { ProviderError } from '../types';
import { PlayoffStatusClient } from './client';
import { POWER_FOUR, conferencePageUrl } from './conferences';
import { parseConferencePage } from './parse';

/**
 * Conference championship odds from playoffstatus.com (the owner's choice, and
 * the only one of the two sources that publishes a RUNNER-UP probability at
 * all — which is the half of the rubric FPI cannot answer).
 *
 * Everything this application knows about that site lives in this directory,
 * the mirror of the rule that only `providers/espn/` knows ESPN exists.
 */

/**
 * How far a conference's columns may drift from one champion and two
 * finalists, in percentage points, before the page is refused.
 *
 * Whole-percent rounding over sixteen-odd teams is worth a few points either
 * way; the measured sums have sat between 99.5 and 202. A dropped row costs
 * several times that, and the first version of this parser dropped exactly one
 * row per page without any other symptom. The windows are 100 ± 4 and 200 ± 6.
 */
export const CHAMPION_SUM = { expected: 100, tolerance: 4 } as const;
export const PARTICIPATE_SUM = { expected: 200, tolerance: 6 } as const;

/**
 * Below this, the table was not read at all — a redesign, an error page, a
 * truncated download. The real pages carry sixteen to eighteen rows, and no
 * power conference has ever been this small.
 */
export const MIN_ROWS = 8;

function offBy(measured: number, { expected, tolerance }: { expected: number; tolerance: number }) {
  return Math.abs(measured - expected) > tolerance;
}

/**
 * A page whose shape no longer holds. This is an `invalid_response` rather than
 * `unavailable`, and not retryable: a redesign will not fix itself on a second
 * request, and the cache's answer should be the last good copy marked `stale`,
 * not a loop of retries against somebody's web server.
 */
function refuse(page: ConferenceOddsPage, reason: string): ProviderError {
  return new ProviderError(
    'invalid_response',
    `playoffstatus ${page.conference} page failed its integrity check: ${reason} ` +
      `(${String(page.rows)} rows, champions ${page.championPercent.toFixed(1)}%, ` +
      `participate ${page.participatePercent.toFixed(1)}%)`,
  );
}

export class PlayoffStatusProvider implements ConferenceOddsProvider {
  readonly name = 'playoffstatus' as const;
  private readonly client: PlayoffStatusClient;

  constructor(client: PlayoffStatusClient = new PlayoffStatusClient()) {
    this.client = client;
  }

  /**
   * All four pages, or none.
   *
   * `season` is accepted because the interface is season-scoped and the cache
   * key is, but the site publishes only the season in progress; there is no
   * per-season URL to ask for. A season's worth of pages is what is there.
   *
   * The four requests go out together. That is four requests at most four times
   * a day behind a 6 h cache, which is the courtesy budget this feature was
   * sized to, and the cron warmer means a viewer's request is not usually one
   * of them.
   */
  async getConferenceOdds(_season: Season): Promise<ConferenceOddsDocument> {
    const pages = await Promise.all(
      POWER_FOUR.map(async (conference) => {
        const html = await this.client.getHtml(conferencePageUrl(conference));
        return parseConferencePage(html, conference);
      }),
    );

    const rows: ConferenceOddsRow[] = [];
    const summaries: ConferenceOddsPage[] = [];

    for (const parsed of pages) {
      const { page } = parsed;
      if (page.rows < MIN_ROWS) throw refuse(page, 'too few rows');
      if (parsed.droppedRows > 0) {
        throw refuse(page, `${String(parsed.droppedRows)} row(s) had no readable percentages`);
      }
      if (offBy(page.championPercent, CHAMPION_SUM)) throw refuse(page, 'champions column');
      if (offBy(page.participatePercent, PARTICIPATE_SUM)) throw refuse(page, 'participate column');

      rows.push(...parsed.rows);
      summaries.push(page);
    }

    return { rows, pages: summaries, computedLabel: commonLabel(summaries) };
  }
}

/**
 * The one stamp every page agrees on, or `null`.
 *
 * Measured on a real capture: two pages said "Sat Sep 26 11:30 pm" and two
 * said "Sun Sep 27 2:45 am", so disagreement is ordinary. Nothing here tries to
 * pick the older of two such strings — that needs a year and a timezone the
 * publisher does not give, and inventing either to put a confident date on
 * screen is precisely what this feature is not allowed to do (§39, §46).
 */
function commonLabel(pages: readonly ConferenceOddsPage[]): string | null {
  const labels = new Set(pages.map((page) => page.computedLabel));
  if (labels.size !== 1) return null;
  return [...labels][0] ?? null;
}
