import type { GameStatus } from '@cfb/shared';
import type { RawStatus } from './raw';

/**
 * ESPN status vocabulary → application `GameStatus` (§18).
 *
 * Keyed on `type.name`, never on `type.state`. A postponed game reports
 * `state: "post"` (espn-notes §3), so a state-based map would render
 * "Final 0–0" for a game that was never played. That would be fabricated sports
 * data, which §4 forbids outright.
 *
 * Only the first four names below were observed in captured payloads. The rest
 * are in ESPN's published vocabulary for other sports and are plausible for
 * college football. Anything not listed becomes `'unknown'` and is logged once.
 * That is the designed behaviour, not a gap (§40).
 */
const STATUS_BY_NAME: Readonly<Record<string, GameStatus>> = {
  // Observed (docs/espn-notes.md §3)
  STATUS_SCHEDULED: 'scheduled',
  STATUS_IN_PROGRESS: 'live',
  STATUS_FINAL: 'final',
  STATUS_POSTPONED: 'postponed',

  // Not yet observed. Halftime and end-of-quarter are still a live game; if
  // they fell through to 'unknown', the board would drop out of live mode and
  // slow its polling at every break.
  STATUS_HALFTIME: 'live',
  STATUS_END_PERIOD: 'live',
  STATUS_FINAL_OT: 'final',
  STATUS_FORFEIT: 'final',
  STATUS_CANCELED: 'canceled',
  STATUS_CANCELLED: 'canceled',
  STATUS_DELAYED: 'delayed',
  STATUS_RAIN_DELAY: 'delayed',
  STATUS_SUSPENDED: 'suspended',
};

const loggedUnknown = new Set<string>();

function logOnce(key: string, message: string): void {
  if (loggedUnknown.has(key)) return;
  loggedUnknown.add(key);
  console.warn(
    JSON.stringify({ level: 'warn', provider: 'espn', event: 'status_unmapped', message }),
  );
}

export function mapStatus(raw: RawStatus | null): GameStatus {
  const name = raw?.name ?? null;
  if (name === null) {
    logOnce('<missing>', 'competition.status.type.name missing; treating game status as unknown');
    return 'unknown';
  }

  const mapped = STATUS_BY_NAME[name];
  if (mapped === undefined) {
    logOnce(name, `unrecognized ESPN status "${name}"; treating as unknown`);
    return 'unknown';
  }

  // Finality needs BOTH the name and `completed === true`. A contradiction
  // (STATUS_FINAL with completed:false) is not something to guess at.
  if (mapped === 'final' && raw?.completed !== true) {
    logOnce(`${name}:incomplete`, `"${name}" arrived with completed !== true; treating as unknown`);
    return 'unknown';
  }

  return mapped;
}

/** Test seam: the log-once memo is module scope. */
export function resetStatusLog(): void {
  loggedUnknown.clear();
}
