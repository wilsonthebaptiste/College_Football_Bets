import type { MatchupBoardResponse } from '@cfb/shared';
import { focusManager, QueryObserver, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { POLL } from '../../lib/poll';
import { createQueryClient } from '../../lib/queryClient';
import { liveMatchup, makeMatchup, matchupBoardResponse } from '../../test/fixtures';
import { matchupBoardQuery } from './useMatchups';

/**
 * Phase 2's exit criterion, "the hidden-tab test drives the real QueryClient
 * with a fake clock", for the matchup board's own query: the app's client,
 * the page's own options, and the API call replaced by a counter. Only the
 * clock and the tab's visibility are simulated.
 *
 * Mutation check, run by hand when this was written: setting
 * `refetchIntervalInBackground: true` in `lib/queryClient.ts` makes the
 * "hidden" assertions below fail (the counter keeps climbing while hidden).
 *
 * TanStack Query never polls on a server, and decides "server" once, at
 * import, from `typeof window`; hoisted above the imports, this makes Node
 * look like a browser for this file only (as `lib/queryClient.test.ts` does).
 */
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = globalThis;
});

let client: QueryClient;
let calls: number;
let answer: MatchupBoardResponse;
let stop: () => void = () => undefined;

function watch(week: string | null): void {
  const observer = new QueryObserver(client, matchupBoardQuery(week));
  stop = observer.subscribe(() => undefined);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-10-10T21:00:00Z'));
  client = createQueryClient();
  client.mount();
  calls = 0;
  stop = () => undefined;
  vi.spyOn(api, 'matchups').mockImplementation(() => {
    calls += 1;
    return Promise.resolve(answer);
  });
});

afterEach(() => {
  stop();
  client.unmount();
  client.clear();
  focusManager.setFocused(undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the matchup board’s polling, on the real query client (§24)', () => {
  it('polls at the live pace on a live Saturday, stops while hidden, and refetches once on return', async () => {
    answer = matchupBoardResponse([liveMatchup()]);
    watch('6');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1); // the first load

    await vi.advanceTimersByTimeAsync(2 * POLL.liveMs);
    expect(calls).toBe(3); // every 15 s while a game is live

    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toBe(3); // five minutes hidden: nothing at all

    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(4); // exactly one refetch on return

    await vi.advanceTimersByTimeAsync(POLL.liveMs);
    expect(calls).toBe(5); // and the live pace picks up again
  });

  it('slows to the idle pace on a quiet weekday, decided by the answer itself', async () => {
    // Kickoff four days out: nothing live, nothing soon, nothing stale.
    answer = matchupBoardResponse([makeMatchup({ kickoffUtc: '2026-10-14T19:30:00Z' })]);
    watch(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(POLL.idleMs - 1_000);
    expect(calls).toBe(1); // not a single extra request inside five minutes

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
  });

  it('does not refetch on a quick tab switch, so switching tabs cannot cause a storm', async () => {
    answer = matchupBoardResponse([liveMatchup()]);
    watch('6');
    await vi.advanceTimersByTimeAsync(0);
    for (let flip = 0; flip < 5; flip += 1) {
      focusManager.setFocused(false);
      await vi.advanceTimersByTimeAsync(500);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(calls).toBe(1);
  });
});
