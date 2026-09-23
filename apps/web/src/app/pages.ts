import { lazy } from 'react';

/**
 * Every page but home, as its own chunk (plan §5.3, "code-split by route").
 *
 * The home page, the usual way in, is in the main bundle. Each page here is
 * fetched when first visited, and the three viewer pages are also fetched in
 * the background once the first page is up (`prefetchViewerPages`, called by
 * `RootLayout`), so moving from home to a board to a team, or into search from
 * the header, never waits on the network for code. The admin pages are never
 * prefetched: viewers never download them, nor the auth library they load
 * (auth/adminAuth.ts).
 *
 * `RootLayout` holds the one `<Suspense>` for all of them. It is already on
 * screen, so a navigation keeps showing the current page until the next one's
 * code has arrived, instead of flashing a loading line.
 */

const loadBoardPage = () => import('../features/board/BoardPage');
const loadTeamPage = () => import('../features/team/TeamPage');
const loadSearchPage = () => import('../features/search/SearchPage');

export const BoardPage = lazy(() =>
  loadBoardPage().then((module) => ({ default: module.BoardPage })),
);
export const TeamPage = lazy(() => loadTeamPage().then((module) => ({ default: module.TeamPage })));
export const SearchPage = lazy(() =>
  loadSearchPage().then((module) => ({ default: module.SearchPage })),
);
export const LoginPage = lazy(() => import('../features/admin/LoginPage'));
export const AdminPage = lazy(() => import('../features/admin/AdminPage'));
export const BoardEditorPage = lazy(() => import('../features/admin/BoardEditorPage'));

/** Fetches the viewer pages' chunks ahead of need. Failures are ignored: the visit retries. */
export function prefetchViewerPages(): void {
  loadBoardPage().catch(() => undefined);
  loadTeamPage().catch(() => undefined);
  // The header's search box links here from every page, so `/search` is as
  // reachable as a board is (plan-search-engine, Phase 3).
  loadSearchPage().catch(() => undefined);
}
