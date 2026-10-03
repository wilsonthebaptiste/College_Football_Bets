import { Outlet, type RouteObject } from 'react-router';
import { RequireAdmin } from '../auth/RequireAdmin';
import { HomePage } from '../features/home/HomePage';
import { NotFoundPage } from './NotFoundPage';
import {
  AdminPage,
  BoardEditorPage,
  BoardPage,
  LoginPage,
  MatchupBoardPage,
  MatchupPage,
  SearchPage,
  TeamPage,
} from './pages';
import { RootLayout } from './RootLayout';

/**
 * §47 — real URLs, a working back button, no modal pretending to be a page.
 * The pages themselves are split into chunks (see `pages.ts`).
 */
export const routes: RouteObject[] = [
  {
    element: <RootLayout />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/u/:userId', element: <BoardPage /> },
      { path: '/teams/:teamId', element: <TeamPage /> },
      // The query lives in `?q=`, not the path: a search IS a URL, shareable
      // and reloadable (plan-search-engine, Phase 3).
      { path: '/search', element: <SearchPage /> },
      // The week lives in `?week=`, so previous/next are real links and the
      // back button walks the weeks (plan-matchup-board, Phase 2; §47).
      { path: '/matchups', element: <MatchupBoardPage /> },
      { path: '/matchups/:gameId', element: <MatchupPage /> },
      { path: '/login', element: <LoginPage /> },
      {
        path: '/admin',
        element: (
          <RequireAdmin>
            <Outlet />
          </RequireAdmin>
        ),
        children: [
          { index: true, element: <AdminPage /> },
          { path: 'u/:userId', element: <BoardEditorPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
