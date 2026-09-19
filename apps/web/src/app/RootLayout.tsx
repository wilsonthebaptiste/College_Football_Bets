import { Suspense, useEffect, useRef } from 'react';
import { Outlet, ScrollRestoration, useLocation } from 'react-router';
import { AdminSessionProvider } from '../auth/AdminSessionProvider';
import { AppHeader } from '../components/AppHeader';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { ErrorState, LoadingNote } from '../components/States';
import { prefetchViewerPages } from './pages';
import styles from './RootLayout.module.css';

/** When the browser is idle after the first page, fetch the other viewer pages' code. */
function whenIdle(work: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(work, { timeout: 3000 });
    return () => window.cancelIdleCallback(handle);
  }
  // Safari has no requestIdleCallback.
  const timer = window.setTimeout(work, 1500);
  return () => window.clearTimeout(timer);
}

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

  useEffect(() => whenIdle(prefetchViewerPages), []);

  return (
    <AdminSessionProvider>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <AppHeader />
      <main id="main" ref={mainRef} tabIndex={-1} className={styles.main}>
        <ErrorBoundary resetKey={location.pathname} fallback={<PageCrashed />}>
          {/* A page's code failing to download (offline, or a deploy since
              this tab loaded) lands in the boundary above: reload fixes both. */}
          <Suspense fallback={<LoadingNote>Loading…</LoadingNote>}>
            <Outlet />
          </Suspense>
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
