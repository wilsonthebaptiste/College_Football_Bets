import { Outlet, type RouteObject } from 'react-router';
import { RequireAdmin } from '../auth/RequireAdmin';
import { HomePage } from '../features/home/HomePage';
import { NotFoundPage } from './NotFoundPage';
import { AdminPage, BoardEditorPage, BoardPage, LoginPage, TeamPage } from './pages';
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
