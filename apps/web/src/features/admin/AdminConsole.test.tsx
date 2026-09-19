import type { AdminBoardResponse, AdminUsersResponse, UserTeamSelection } from '@cfb/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../lib/api';
import { ApiError } from '../../lib/apiClient';
import { makeTeam } from '../../test/fixtures';
import { RAW_VALUE, renderAt, spokenText, visibleText } from '../../test/render';
import AdminPage from './AdminPage';
import BoardEditorPage from './BoardEditorPage';

/**
 * The admin console as it renders for a given server answer (plan §5.1). The
 * interactions themselves (pressing Up, confirming a removal) are exercised in
 * a real browser: see README "Testing Phase 5". What these pin down is what is
 * on screen, and what a screen reader is told, for each state.
 */

vi.mock('../../auth/AdminSessionProvider', () => ({
  useAdminSession: () => ({
    status: 'signed-in',
    email: 'admin@example.test',
    configured: true,
    authHooks: null,
    prepare: async () => undefined,
    signIn: async () => null,
    signOut: async () => undefined,
  }),
}));

const USER_ID = '00000000-0000-4000-8000-000000009001';

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
}

function selection(order: number, overrides: Parameters<typeof makeTeam>[0]): UserTeamSelection {
  return {
    id: `00000000-0000-4000-8000-00000000500${String(order)}`,
    order,
    createdAt: '2026-09-01T00:00:00Z',
    team: makeTeam(overrides),
  };
}

const SIX: UserTeamSelection[] = [
  selection(1, { providerTeamId: '333', name: 'Alabama Crimson Tide', displayName: 'Alabama' }),
  selection(2, { providerTeamId: '61', name: 'Georgia Bulldogs', displayName: 'Georgia' }),
  selection(3, { providerTeamId: '251', name: 'Texas Longhorns', displayName: 'Texas' }),
  selection(4, {
    providerTeamId: '130',
    name: 'Michigan Wolverines',
    displayName: 'Michigan',
    conference: 'Big Ten',
  }),
  selection(5, {
    providerTeamId: '30',
    name: 'USC Trojans',
    displayName: 'USC',
    conference: 'Big Ten',
  }),
  selection(6, { providerTeamId: '99', name: 'LSU Tigers', displayName: 'LSU', conference: null }),
];

function renderEditor(selections: UserTeamSelection[] | ApiError) {
  const queries = client();
  if (selections instanceof ApiError) {
    queries
      .getQueryCache()
      .build(queries, { queryKey: queryKeys.adminBoard(USER_ID) })
      .setState({ status: 'error', error: selections, fetchStatus: 'idle' });
  } else {
    const board: AdminBoardResponse = { user: { id: USER_ID, displayName: 'Wilson' }, selections };
    queries.setQueryData(queryKeys.adminBoard(USER_ID), board);
  }
  const markup = renderAt(`/admin/u/${USER_ID}`, '/admin/u/:userId', <BoardEditorPage />, queries);
  return { markup, seen: visibleText(markup), heard: spokenText(markup) };
}

describe('the board editor (plan §5.1)', () => {
  it('lists the teams in board order, each with its position and conference', () => {
    const { seen, markup } = renderEditor(SIX);
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(seen).toContain("Wilson's board");
    const order = ['Alabama', 'Georgia', 'Texas', 'Michigan', 'USC', 'LSU'].map((name) =>
      seen.indexOf(name),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(seen).toContain('Michigan Big Ten');
    expect(markup).not.toMatch(RAW_VALUE);
  });

  it('names every button after its team, for a screen reader (§48)', () => {
    const { markup } = renderEditor(SIX);
    expect(markup).toContain('aria-label="Move Alabama up"');
    expect(markup).toContain('aria-label="Move Alabama down"');
    expect(markup).toContain('aria-label="Remove LSU"');
  });

  it('disables Up on the first team and Down on the last, and nothing else', () => {
    const { markup } = renderEditor(SIX);
    const disabled = [...markup.matchAll(/<button[^>]*disabled=""[^>]*>/g)].map(
      (match) => /aria-label="([^"]+)"/.exec(match[0])?.[1],
    );
    expect(disabled).toEqual(['Move Alabama up', 'Move LSU down']);
  });

  it('says each position to a screen reader, not only as a big numeral', () => {
    const { heard } = renderEditor(SIX);
    expect(heard).toContain('1. Alabama');
    expect(heard).toContain('6. LSU');
  });

  it('warns, but allows, a board above six', () => {
    const seven = [
      ...SIX,
      selection(7, {
        providerTeamId: '194',
        name: 'Ohio State Buckeyes',
        displayName: 'Ohio State',
      }),
    ];
    const { seen } = renderEditor(seven);
    expect(seen).toContain('This board has 7 teams. Boards are designed for 6');
    expect(seen).toContain('Ohio State');
  });

  it('counts the teams still to add below six, and says nothing at six', () => {
    expect(renderEditor(SIX.slice(0, 4)).seen).toContain('This board has 4 of its 6 teams.');
    const atSix = renderEditor(SIX).seen;
    expect(atSix).not.toContain('of its 6 teams');
    expect(atSix).not.toContain('the extra teams');
    // The search, not the list, mentions that six is the design.
    expect(atSix).toContain('This board has 6 teams already. Adding more is allowed');
    expect(renderEditor([]).seen).toContain('This board has no teams yet.');
  });

  it('links to the public board it edits', () => {
    const { markup } = renderEditor(SIX);
    expect(markup).toContain(`href="/u/${USER_ID}"`);
  });

  it('offers team search with its instructions, and no results before typing', () => {
    const { seen, markup } = renderEditor(SIX);
    expect(seen).toContain('Find a team');
    expect(seen).toContain('Type at least 2 letters');
    expect(markup).toContain('type="search"');
    expect(markup).not.toContain('Search results');
  });

  it('a board that does not exist says so, with no retry loop', () => {
    const { seen } = renderEditor(
      new ApiError({ kind: 'not_found', message: 'No such user.', requestId: 'r-1' }, 404),
    );
    expect(seen).toContain('No such person');
    expect(seen).not.toContain('Try again');
  });

  it('any other failure offers Try again and the request id', () => {
    const { seen } = renderEditor(
      new ApiError({ kind: 'internal', message: 'Something went wrong.', requestId: 'r-2' }, 500),
    );
    expect(seen).toContain("Couldn't load this board");
    expect(seen).toContain('Try again');
    expect(seen).toContain('Reference: r-2');
  });
});

describe('the people list (plan §5.1)', () => {
  function renderPeople(users: AdminUsersResponse['users']) {
    const queries = client();
    queries.setQueryData(queryKeys.adminUsers, { users } satisfies AdminUsersResponse);
    const markup = renderAt('/admin', '/admin', <AdminPage />, queries);
    return { markup, seen: visibleText(markup) };
  }

  it('lists each person with their team count and the three actions', () => {
    const { seen, markup } = renderPeople([
      { id: USER_ID, displayName: 'Wilson', teamCount: 6 },
      { id: '00000000-0000-4000-8000-000000009002', displayName: 'Avery', teamCount: 1 },
    ]);
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(seen).toContain('Wilson 6 teams');
    expect(seen).toContain('Avery 1 team');
    expect(markup).toContain(`href="/admin/u/${USER_ID}"`);
    expect(markup).toContain('aria-label="Edit board for Wilson"');
    expect(markup).toContain('aria-label="Rename Wilson"');
    expect(markup).toContain('aria-label="Delete Wilson"');
    expect(markup).not.toMatch(RAW_VALUE);
  });

  it('says who is signed in, and that adding a person creates no login (plan §11.1)', () => {
    const { seen } = renderPeople([]);
    expect(seen).toContain('Signed in as admin@example.test');
    expect(seen).toContain('It creates no login');
    expect(seen).toContain('Nobody yet');
  });

  it('labels the add form', () => {
    const { markup } = renderPeople([]);
    expect(markup).toMatch(/<label[^>]*><span>Add a person<\/span><input/);
  });
});
