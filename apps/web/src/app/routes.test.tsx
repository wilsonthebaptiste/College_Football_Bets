import { describe, expect, it } from 'vitest';
import { routes } from './routes';

/**
 * The header — and so the search box in it — is on every page because every
 * page is a child of one layout route (plan-search-engine, Phase 4: "a search
 * box on every page"). That is structure, not repetition, so this is where it
 * is pinned: a page added outside `RootLayout` would have no header, and no
 * component test would notice.
 */

const layout = routes[0];

describe('every page sits under the one layout that carries the header', () => {
  it('is a single layout route, with no address of its own', () => {
    expect(routes).toHaveLength(1);
    expect(layout?.path).toBeUndefined();
    expect(layout?.element).toBeDefined();
  });

  it('holds home, a board, a team, search, login, admin, and not-found', () => {
    expect((layout?.children ?? []).map((route) => route.path)).toEqual([
      '/',
      '/u/:userId',
      '/teams/:teamId',
      '/search',
      '/login',
      '/admin',
      '*',
    ]);
  });

  it('puts the admin pages under the layout too, behind their guard', () => {
    const admin = (layout?.children ?? []).find((route) => route.path === '/admin');
    expect((admin?.children ?? []).map((route) => route.path)).toEqual([undefined, 'u/:userId']);
  });
});
