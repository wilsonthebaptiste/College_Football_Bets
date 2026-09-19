import { lazy, Suspense, type ReactNode } from 'react';
import type { RouteObject } from 'react-router';
import { RequireAdmin } from '../auth/RequireAdmin';
import { LoadingNote } from '../components/States';
import { BoardPage } from '../features/board/BoardPage';
import { HomePage } from '../features/home/HomePage';
import { TeamPage } from '../features/team/TeamPage';
import { NotFoundPage } from './NotFoundPage';
import { RootLayout } from './RootLayout';

/**
 * §47 — real URLs, a working back button, no modal pretending to be a page.
 *
 * The three viewer pages are in the main bundle. The admin pages are split
 * out, and the auth library they use is split out again (see auth/adminAuth.ts),
 * so a viewer downloads neither.
 */
const LoginPage = lazy(() => import('../features/admin/LoginPage'));
const AdminPage = lazy(() => import('../features/admin/AdminPage'));

function Deferred({ children }: { children: ReactNode }) {
  return <Suspense fallback={<LoadingNote>Loading…</LoadingNote>}>{children}</Suspense>;
}

export const routes: RouteObject[] = [
  {
    element: <RootLayout />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/u/:userId', element: <BoardPage /> },
      { path: '/teams/:teamId', element: <TeamPage /> },
      {
        path: '/login',
        element: (
          <Deferred>
            <LoginPage />
          </Deferred>
        ),
      },
      {
        path: '/admin',
        element: (
          <RequireAdmin>
            <Deferred>
              <AdminPage />
            </Deferred>
          </RequireAdmin>
        ),
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
