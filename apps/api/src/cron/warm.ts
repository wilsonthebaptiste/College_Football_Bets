import { supabasePublic } from '../db/client';
import { listUsers } from '../db/queries';
import type { Env } from '../env';
import { resolveSeason } from '../season/resolve';
import { createServices } from '../services/context';
import { readConferences, readTeamList } from '../services/search';
import { readRankings } from '../services/snapshot';

/**
 * Cron warmers (plan §5.4; Phase 2's notes on CPU and the KV budget).
 *
 * What they do, and why each is here:
 *   - The season calendar, the rankings, the team list, and the conference
 *     map are read through the normal cache. When one has expired, the cron
 *     refreshes it and the fresh copy lands in KV, so a viewer's request finds
 *     it there instead of fetching and parsing ESPN on the request path. The
 *     team list is the heaviest parse (about 6.6 ms of the 10 ms CPU budget).
 *   - One `select` from Postgres, so the free Supabase project never sits
 *     idle long enough to be paused (about 7 days; §10 risk register).
 *
 * What they deliberately do not warm:
 *   - Schedules. Fifty teams refreshed hourly would be 1,200 KV writes a day,
 *     over the free tier's roughly 1,000. Boards warm their own schedules
 *     when someone looks at them, which is the only time it matters.
 *   - Live scoreboards. Those live in L1 only (25 s), and L1 belongs to one
 *     isolate: a cron run warms nobody's cache but its own.
 *
 * Every read goes through the same per-key KV write intervals as a request,
 * so the cron adds at most a handful of KV writes a day: rankings hourly, the
 * calendar every 6 h, the team list and conferences daily.
 */

/** Every 10 minutes on autumn weekends (UTC Fri–Sun covers US Friday nights and Saturdays). */
export const CRON_GAME_DAYS = '*/10 * * 8-12,1 FRI,SAT,SUN';
/** Hourly, all year. Skipped when the game-day schedule is also firing. */
export const CRON_HOURLY = '0 * * * *';

/** August through January, Friday to Sunday, in UTC: when `CRON_GAME_DAYS` fires. */
export function isGameDayWindow(at: Date): boolean {
  const month = at.getUTCMonth() + 1;
  const day = at.getUTCDay(); // 0 = Sunday
  const autumn = month >= 8 || month === 1;
  return autumn && (day === 5 || day === 6 || day === 0);
}

export type WarmOutcome = { ok: true; detail: string } | { ok: false; detail: string };

export interface WarmReport {
  cron: string;
  skipped: boolean;
  results: Record<string, WarmOutcome>;
}

async function attempt(work: () => Promise<string>): Promise<WarmOutcome> {
  try {
    return { ok: true, detail: await work() };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export interface WarmOptions {
  cron: string;
  scheduledTime: number;
  defer: ((work: Promise<unknown>) => void) | null;
}

export async function runWarmers(env: Env, options: WarmOptions): Promise<WarmReport> {
  // Both triggers fire at the top of the hour on game days. One run is enough.
  if (options.cron === CRON_HOURLY && isGameDayWindow(new Date(options.scheduledTime))) {
    return { cron: options.cron, skipped: true, results: {} };
  }

  const services = createServices(env, {
    requestId: `cron-${String(options.scheduledTime)}`,
    defer: options.defer,
  });

  const [season, rankings, teams, conferences, database] = await Promise.all([
    attempt(async () => {
      const resolved = await resolveSeason(services);
      return `${String(resolved.season.year)} ${resolved.season.type} (${resolved.source})`;
    }),
    attempt(async () => {
      const { season: current } = await resolveSeason(services);
      const read = await readRankings(services, current);
      if (read.status === 'unavailable')
        throw new Error(read.envelope.error?.message ?? 'unavailable');
      return read.status;
    }),
    attempt(async () => `${String((await readTeamList(services)).length)} teams`),
    attempt(
      async () => `${String(Object.keys(await readConferences(services)).length)} teams mapped`,
    ),
    attempt(async () => `${String((await listUsers(supabasePublic(env))).length)} users`),
  ]);

  const report: WarmReport = {
    cron: options.cron,
    skipped: false,
    results: { season, rankings, teams, conferences, database },
  };
  const failed = Object.values(report.results).some((result) => !result.ok);
  console[failed ? 'warn' : 'log'](
    JSON.stringify({ level: failed ? 'warn' : 'info', event: 'cron_warm', ...report }),
  );
  return report;
}
