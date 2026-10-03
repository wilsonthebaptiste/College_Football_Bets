import type { ProjectionsResponse, UsersResponse } from '@cfb/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../lib/api';
import { ApiError } from '../../lib/apiClient';
import {
  boardSummary,
  inputDown,
  projectionSources,
  projectionsResponse,
} from '../../test/fixtures';
import { RAW_VALUE, renderAt, spokenText, visibleText } from '../../test/render';
import { HomePage } from './HomePage';

/**
 * The home page with projected points (predicting_score.md, Phase 4): a total
 * beside each name, from one leaderboard request, and a page that is exactly
 * as useful as before when that request is slow or fails.
 */

const ID = {
  avery: '11111111-1111-4111-8111-000000000001',
  blake: '11111111-1111-4111-8111-000000000002',
  casey: '11111111-1111-4111-8111-000000000003',
  drew: '11111111-1111-4111-8111-000000000004',
};

/** The people list, alphabetical, which is the order the tiles keep. */
const USERS: UsersResponse = {
  users: [
    { id: ID.avery, displayName: 'Avery', teamCount: 6 },
    { id: ID.blake, displayName: 'Blake', teamCount: 6 },
    { id: ID.casey, displayName: 'Casey', teamCount: 6 },
    { id: ID.drew, displayName: 'Drew', teamCount: 0 },
  ],
};

/** The leaderboard, highest first — a different order from the tiles'. */
function leaderboard(): ProjectionsResponse {
  return projectionsResponse([
    boardSummary(ID.casey, 'Casey', 13.4412),
    boardSummary(ID.avery, 'Avery', 9.0751, 3, 6),
    boardSummary(ID.blake, 'Blake', null, 0, 6),
    boardSummary(ID.drew, 'Drew', null, 0, 0),
  ]);
}

type Seed = ProjectionsResponse | ApiError | undefined;

/** `users: null` leaves the people list loading. */
function renderHome(projections: Seed, users: UsersResponse | null = USERS) {
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  if (users !== null) client.setQueryData(queryKeys.users, users);
  if (projections instanceof ApiError) {
    client.getQueryCache().build(client, { queryKey: queryKeys.projections }).setState({
      status: 'error',
      error: projections,
      errorUpdatedAt: Date.now(),
      fetchStatus: 'idle',
    });
  } else if (projections !== undefined) {
    client.setQueryData(queryKeys.projections, projections);
  }
  const markup = renderAt('/', '/', <HomePage />, client);
  return { markup, seen: visibleText(markup), heard: spokenText(markup), client };
}

/** One tile's text, by the person's id, without its decorative monogram. */
function tile(markup: string, userId: string): string {
  const found = markup.match(new RegExp(`<a[^>]*href="/u/${userId}"[^>]*>.*?</a>`));
  return visibleText(found?.[0] ?? '').replace(/^\S+ /, '');
}

describe('a total beside each name', () => {
  const { markup, seen } = renderHome(leaderboard());

  it('puts the total on the tile, number first', () => {
    expect(tile(markup, ID.casey)).toBe('Casey 6 teams 13.44 projected points');
  });

  it('says how much of a board is behind a partial total, rather than letting it pass as whole', () => {
    expect(tile(markup, ID.avery)).toBe('Avery 6 teams 9.08 projected points from 3 of 6 teams');
  });

  it('says "no projected total" for a board nothing is known about — never 0.00', () => {
    expect(tile(markup, ID.blake)).toBe('Blake 6 teams No projected total');
    expect(seen).not.toContain('0.00');
  });

  it('says nothing about a board with no teams, whose count already says it', () => {
    expect(tile(markup, ID.drew)).toBe('Drew 0 teams');
  });

  it('keeps the tiles in the people list’s order, not the leaderboard’s, and names no winner', () => {
    const positions = ['Avery', 'Blake', 'Casey', 'Drew'].map((name) => seen.indexOf(name));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(seen).not.toMatch(/winning|leader|first place/i);
  });

  it('says once what the totals are, and names both publishers with their own stamps', () => {
    expect(seen.match(/Not a result\./g)).toHaveLength(1);
    expect(seen).toContain('Projection · as of Sep 30 (ESPN FPI) and');
    expect(seen).toContain('(playoffstatus.com)');
    expect(seen).not.toMatch(/\blive\b/i);
  });

  it('has one h1 and no raw value', () => {
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(seen).not.toMatch(RAW_VALUE);
    expect(seen).not.toContain('-0.00');
  });
});

describe('one projection request for the whole page', () => {
  it('asks under the one leaderboard key, however many tiles there are', () => {
    const { client } = renderHome(undefined);
    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey)
      .filter((key) => key[0] === 'projections');
    expect(keys).toEqual([queryKeys.projections]);
  });
});

describe('a failed or slow projection costs the page nothing (§42)', () => {
  const DOWN = new ApiError(
    { kind: 'internal', message: 'Something went wrong on the server.', requestId: 'r-p1' },
    500,
  );
  const LIMITED = new ApiError(
    {
      kind: 'rate_limited',
      message: 'Too many requests. Wait a moment and try again.',
      requestId: 'r-p2',
    },
    429,
  );

  it.each([
    ['failed', DOWN],
    ['rate-limited (429)', LIMITED],
  ])('keeps every tile and name when the projection %s', (_, error) => {
    const { markup, seen } = renderHome(error);
    expect(tile(markup, ID.casey)).toBe('Casey 6 teams');
    expect(markup.match(/<a[^>]*href="\/u\//g)).toHaveLength(4);
    expect(seen).toContain('Projected points are unavailable right now.');
    // Garnish, not the page's job: no alert, no heading, no request id shouted.
    expect(markup).not.toContain('role="alert"');
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(seen).not.toMatch(RAW_VALUE);
  });

  it('keeps every tile, and holds each tile’s space, while the projection is on its way', () => {
    const { markup, seen, heard } = renderHome(undefined);
    expect(tile(markup, ID.casey)).toBe('Casey 6 teams');
    expect(seen).not.toContain('projected');
    expect(heard).not.toMatch(/loading/i);
    expect(markup.match(/<h1/g)).toHaveLength(1);
  });

  it('shows the totals it has when both publishers are down, as no totals rather than zeros', () => {
    const sources = projectionSources({ fpi: inputDown(), conference_odds: inputDown() });
    const { markup, seen } = renderHome(
      projectionsResponse(
        [boardSummary(ID.avery, 'Avery', null, 0, 6), boardSummary(ID.casey, 'Casey', null, 0, 6)],
        sources,
      ),
    );
    expect(tile(markup, ID.avery)).toBe('Avery 6 teams No projected total');
    expect(seen).toContain('Couldn’t load ESPN FPI and the conference odds.');
    expect(seen).not.toContain('0.00');
  });

  it('keeps its one h1 while the people list itself is loading', () => {
    const { markup, heard } = renderHome(undefined, null);
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(heard).toContain('Loading boards…');
  });
});
