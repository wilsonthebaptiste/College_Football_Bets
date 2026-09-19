import { useEffect, useRef } from 'react';
import { Outlet, ScrollRestoration, useLocation } from 'react-router';
import { AdminSessionProvider } from '../auth/AdminSessionProvider';
import { AppHeader } from '../components/AppHeader';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { ErrorState } from '../components/States';
import styles from './RootLayout.module.css';

/**
 * Every page's frame: skip link, header, and one <main>.
 *
 * After each navigation, focus moves to <main>, so a keyboard or screen-reader
 * user starts at the top of the new page rather than wherever the old page
 * left them (§48). The first page load is left alone.
 */
export function RootLayout() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [location.pathname]);

  return (
    <AdminSessionProvider>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <AppHeader />
      <main id="main" ref={mainRef} tabIndex={-1} className={styles.main}>
        <ErrorBoundary resetKey={location.pathname} fallback={<PageCrashed />}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <ScrollRestoration />
    </AdminSessionProvider>
  );
}

function PageCrashed() {
  return (
    <ErrorState
      title="This page couldn't be displayed"
      message="Something unexpected went wrong. Reloading usually fixes it."
      action={
        <button type="button" className="button" onClick={() => window.location.reload()}>
          Reload the page
        </button>
      }
    />
  );
}
