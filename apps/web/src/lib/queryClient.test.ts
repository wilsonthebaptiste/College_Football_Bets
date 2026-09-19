import { focusManager, QueryObserver, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLL } from './poll';
import { createQueryClient } from './queryClient';

/**
 * §24 and Phase 4's exit criterion, "hidden tab: polling stopped, then a
 * single refetch on focus", run against the real query client with the
 * app's own defaults. Only the clock and the tab's visibility are simulated.
 *
 * TanStack Query never polls on a server, and it decides "server" once, at
 * import, from `typeof window`. Hoisted above the imports, this makes Node
 * look like a browser for this file only (Vitest isolates each test file).
 */
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = globalThis;
});

let client: QueryClient;
let calls: number;
let stop: () => void = () => undefined;

function poll(intervalMs: number): void {
  const observer = new QueryObserver(client, {
    queryKey: ['poll-test'],
    queryFn: () => {
      calls += 1;
      return Promise.resolve(calls);
    },
    refetchInterval: intervalMs,
  });
  stop = observer.subscribe(() => undefined);
}

beforeEach(() => {
  vi.useFakeTimers();
  client = createQueryClient();
  client.mount();
  calls = 0;
  stop = () => undefined;
});

afterEach(() => {
  stop();
  client.unmount();
  client.clear();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe('a hidden tab stops polling (§24)', () => {
  it('is the app-wide default', () => {
    const queries = client.getDefaultOptions().queries;
    expect(queries?.refetchIntervalInBackground).toBe(false);
    expect(queries?.refetchOnWindowFocus).toBe(true);
  });

  it('polls while visible, stops while hidden, and refetches once on return', async () => {
    poll(POLL.liveMs);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1); // the first load

    await vi.advanceTimersByTimeAsync(2 * POLL.liveMs);
    expect(calls).toBe(3); // polling at the live pace

    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(calls).toBe(3); // two minutes hidden: nothing

    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(4); // exactly one refetch on return

    await vi.advanceTimersByTimeAsync(POLL.liveMs);
    expect(calls).toBe(5); // and the interval picks up again
  });

  it('does not refetch on a quick tab switch, so switching tabs cannot cause a storm', async () => {
    poll(POLL.activeMs);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    for (let flip = 0; flip < 5; flip += 1) {
      focusManager.setFocused(false);
      await vi.advanceTimersByTimeAsync(500);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(500);
    }
    // Five returns inside `POLL.staleTimeMs` of the last read: no extra requests.
    expect(calls).toBe(1);
  });
});
