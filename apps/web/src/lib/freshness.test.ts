import { describe, expect, it } from 'vitest';
import {
  envelope,
  makeBoard,
  makeBoardTeam,
  makeSnapshot,
  makeTeam,
  PROVIDER_DOWN,
} from '../test/fixtures';
import { rankingPollOf, summarizeBoardFreshness } from './freshness';

function card(state: 'fresh' | 'cached' | 'stale', fetchedAt: string) {
  const team = makeTeam();
  return makeBoardTeam(envelope(makeSnapshot(team), state, null, fetchedAt), team);
}

describe('summarizeBoardFreshness (§23, §39)', () => {
  it('reports the OLDEST card’s time, not when the board was assembled', () => {
    const board = makeBoard(
      [
        card('fresh', '2026-10-01T17:59:00.000Z'),
        card('cached', '2026-10-01T17:45:00.000Z'),
        card('fresh', '2026-10-01T17:58:00.000Z'),
      ],
      { generatedAt: '2026-10-01T18:00:00.000Z' },
    );
    expect(summarizeBoardFreshness(board)).toEqual({
      oldestFetchedAt: '2026-10-01T17:45:00.000Z',
      anyStale: false,
      unavailableCount: 0,
    });
  });

  it('flags the board when any card is stale', () => {
    const board = makeBoard([
      card('fresh', '2026-10-01T17:59:00.000Z'),
      card('stale', '2026-10-01T16:00:00.000Z'),
    ]);
    const summary = summarizeBoardFreshness(board);
    expect(summary.anyStale).toBe(true);
    expect(summary.oldestFetchedAt).toBe('2026-10-01T16:00:00.000Z');
  });

  it('leaves failed cards out of the timestamp and counts them instead', () => {
    const board = makeBoard([
      card('fresh', '2026-10-01T17:59:00.000Z'),
      makeBoardTeam(envelope(null, 'unavailable', PROVIDER_DOWN)),
    ]);
    expect(summarizeBoardFreshness(board)).toEqual({
      oldestFetchedAt: '2026-10-01T17:59:00.000Z',
      anyStale: false,
      unavailableCount: 1,
    });
  });

  it('has no timestamp at all when nothing loaded, rather than an invented one', () => {
    const board = makeBoard([makeBoardTeam(envelope(null, 'unavailable', PROVIDER_DOWN))]);
    expect(summarizeBoardFreshness(board).oldestFetchedAt).toBeNull();
  });
});

describe('rankingPollOf (§7: ranks are labeled)', () => {
  it('names the poll of the first ranked team', () => {
    expect(rankingPollOf(makeBoard([card('fresh', '2026-10-01T17:59:00.000Z')]))).toBe('AP Top 25');
  });

  it('names nothing when no team is ranked', () => {
    const team = makeTeam();
    const unranked = makeBoardTeam(
      envelope(makeSnapshot(team, { ranking: { kind: 'unranked' } })),
      team,
    );
    const unknown = makeBoardTeam(
      envelope(makeSnapshot(team, { ranking: { kind: 'unavailable' } })),
      team,
    );
    expect(rankingPollOf(makeBoard([unranked, unknown]))).toBeNull();
  });
});
