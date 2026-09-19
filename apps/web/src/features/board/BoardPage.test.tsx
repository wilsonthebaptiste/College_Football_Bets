import type { BoardResponse } from '@cfb/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { queryKeys } from '../../lib/api';
import { ApiError } from '../../lib/apiClient';
import {
  envelope,
  makeBoard,
  makeBoardTeam,
  makeSnapshot,
  makeTeam,
  PROVIDER_DOWN,
} from '../../test/fixtures';
import { RAW_VALUE, renderAt, visibleText } from '../../test/render';
import { TeamPage } from '../team/TeamPage';
import { BoardPage } from './BoardPage';

const TEAM_NAMES = ['Alabama', 'Georgia', 'Texas', 'Michigan', 'USC', 'LSU'];

function wilsonsBoard(): BoardResponse {
  return makeBoard(
    TEAM_NAMES.map((name, index) => {
      const team = makeTeam({ displayName: name, name: `${name} Full Name` });
      return makeBoardTeam(
        envelope(makeSnapshot(team), 'fresh', null, `2026-10-01T17:5${String(index)}:00.000Z`),
        team,
        index + 1,
      );
    }),
  );
}

function renderBoard(board: BoardResponse | null, error?: ApiError) {
  // `retryOnMount: false` holds a seeded error in place; otherwise mounting
  // would (correctly) show a fresh attempt as loading.
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const userId = board?.user.id ?? 'missing';
  if (board !== null) client.setQueryData(queryKeys.board(userId), board);
  if (error !== undefined) {
    client
      .getQueryCache()
      .build(client, { queryKey: queryKeys.board(userId) })
      .setState({ status: 'error', error, errorUpdatedAt: Date.now(), fetchStatus: 'idle' });
  }
  const markup = renderAt(`/u/${userId}`, '/u/:userId', <BoardPage />, client);
  return { markup, seen: visibleText(markup) };
}

describe('BoardPage (§13)', () => {
  it('names the person, the season, and the poll, then shows all six teams in order', () => {
    const { markup, seen } = renderBoard(wilsonsBoard());
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(markup).toMatch(/<h1[^>]*>Wilson<\/h1>/);
    expect(seen).toContain('2026 season, week 5');
    expect(seen).toContain('Rankings: AP Top 25');
    expect(markup.match(/<article/g)).toHaveLength(6);

    const positions = TEAM_NAMES.map((name) => seen.indexOf(`${name} `));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions); // §44: order preserved
  });

  it('reports the oldest card’s time as "Last updated", not when the board was built', () => {
    const { markup, seen } = renderBoard(wilsonsBoard());
    expect(seen).toContain('Last updated:');
    expect(markup).toContain('dateTime="2026-10-01T17:50:00.000Z"');
  });

  it('flags the whole board when any card is stale (§39)', () => {
    const board = wilsonsBoard();
    const [first] = board.teams;
    if (first === undefined) throw new Error('fixture');
    first.snapshot = envelope(first.snapshot.data, 'stale', null, '2026-10-01T15:00:00.000Z');
    const { seen } = renderBoard(board);
    expect(seen).toContain('May be out of date. Last updated:');
  });

  it('shows five good cards and one failed card as a normal board (§42)', () => {
    const board = wilsonsBoard();
    const [first] = board.teams;
    if (first === undefined) throw new Error('fixture');
    first.snapshot = envelope(null, 'unavailable', PROVIDER_DOWN);

    const { markup, seen } = renderBoard(board);
    expect(markup.match(/<article/g)).toHaveLength(6);
    expect(seen).toContain('Sports data temporarily unavailable.');
    expect(seen.match(/#4/g)).toHaveLength(5);
    expect(seen).not.toMatch(RAW_VALUE);
  });

  it('has clean unavailable states when every card failed and there is no cache', () => {
    const board = makeBoard(
      TEAM_NAMES.map((name) =>
        makeBoardTeam(
          envelope(null, 'unavailable', PROVIDER_DOWN),
          makeTeam({ displayName: name }),
        ),
      ),
    );
    const { seen } = renderBoard(board);
    expect(seen.match(/Sports data temporarily unavailable\./g)).toHaveLength(6);
    expect(seen).not.toContain('Last updated');
    expect(seen).not.toContain('Rankings:');
    expect(seen).not.toMatch(RAW_VALUE);
  });

  it('shows skeleton cards, and says so, on the first load', () => {
    const { markup, seen } = renderBoard(null);
    expect(seen).toContain('Loading board…');
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('<article');
  });

  it('explains a missing board rather than showing an empty page', () => {
    const { seen } = renderBoard(
      null,
      new ApiError({ kind: 'not_found', message: 'No such user.', requestId: 'r1' }, 404),
    );
    expect(seen).toContain('Board not found');
    expect(seen).toContain('All boards');
  });

  it('offers a retry, with the request id, when the board could not load', () => {
    const { seen } = renderBoard(
      null,
      new ApiError(
        { kind: 'internal', message: 'Something went wrong on the server.', requestId: 'r2' },
        500,
      ),
    );
    expect(seen).toContain('Unable to load this board');
    expect(seen).toContain('Try again');
    expect(seen).toContain('Reference: r2');
  });

  it('says so plainly when a board has no teams', () => {
    const { seen } = renderBoard(makeBoard([]));
    expect(seen).toContain('No teams yet');
  });
});

describe('TeamPage (Phase 3 scope)', () => {
  it('opens instantly from a loaded board, using the card’s data as a placeholder', () => {
    const board = wilsonsBoard();
    const client = new QueryClient();
    client.setQueryData(queryKeys.board(board.user.id), board);
    const team = board.teams[2]?.team;
    if (team === undefined) throw new Error('fixture');

    const markup = renderAt(`/teams/${team.id}`, '/teams/:teamId', <TeamPage />, client);
    const seen = visibleText(markup);
    expect(markup).toMatch(/<h1[^>]*>Texas<\/h1>/);
    expect(seen).toContain('Texas Full Name, SEC');
    expect(seen).toContain('Previous game');
    expect(seen).toContain('Next game');
    expect(seen).toContain('TV: CBS');
    expect(seen).not.toMatch(RAW_VALUE);
  });

  it('keeps the team’s identity when its sports data failed', () => {
    const team = makeTeam({ displayName: 'Texas' });
    const client = new QueryClient();
    client.setQueryData(queryKeys.team(team.id), {
      team,
      season: { year: 2026, type: 'regular', week: 5 },
      snapshot: envelope(null, 'unavailable', PROVIDER_DOWN),
    });
    const markup = renderAt(`/teams/${team.id}`, '/teams/:teamId', <TeamPage />, client);
    const seen = visibleText(markup);
    expect(seen).toContain('Texas');
    expect(seen).toContain('Sports data temporarily unavailable.');
    expect(seen).toContain('Reference: req-123');
  });

  it('shows a loading state with no board to borrow from', () => {
    const markup = renderAt('/teams/abc', '/teams/:teamId', <TeamPage />);
    expect(visibleText(markup)).toContain('Loading team data…');
  });
});

describe('ErrorBoundary (one card cannot blank a board)', () => {
  it('switches to the fallback on a render error', () => {
    expect(ErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it('clears the error when its reset key changes, so the next poll can recover', () => {
    const failed = { failed: true, resetKey: 1 };
    expect(
      ErrorBoundary.getDerivedStateFromProps(
        { children: null, fallback: null, resetKey: 1 },
        failed,
      ),
    ).toBeNull();
    expect(
      ErrorBoundary.getDerivedStateFromProps(
        { children: null, fallback: null, resetKey: 2 },
        failed,
      ),
    ).toEqual({ failed: false, resetKey: 2 });
  });
});
