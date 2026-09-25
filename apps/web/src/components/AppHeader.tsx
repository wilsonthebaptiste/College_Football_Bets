import { Link, NavLink } from 'react-router';
import { useAdminSession } from '../auth/AdminSessionProvider';
import { useAdminCheck } from '../auth/useAdminCheck';
import { cx } from '../lib/cx';
import { APP_NAME } from '../lib/useDocumentTitle';
import { HeaderSearch } from './HeaderSearch';
import { FootballIcon } from './icons';
import styles from './AppHeader.module.css';

/**
 * The top bar. The Admin link appears only once the Worker has confirmed the
 * signed-in account is an administrator, so a signed-in non-admin never sees
 * it (Phase 3's Level C finding). `/login` is never linked and stays reachable
 * by URL (plan §3.1). Hiding the link protects nothing, and is not meant to:
 * the database does (§31).
 *
 * The search box is last, after the nav, in the markup and on screen alike:
 * the row wraps and never reorders, so what Tab visits next is always what is
 * next along the line (§48). The plan asked for it between the wordmark and
 * the nav; that order costs a third header row on a phone, because the box
 * breaks onto its own line and pushes the nav onto another. Measured at
 * 320 px: 113 px of header this way, 165 px the other.
 */
export function AppHeader() {
  const { status } = useAdminSession();
  const check = useAdminCheck();
  const isAdmin = status === 'signed-in' && check.isSuccess;

  return (
    <header className={styles.bar}>
      <div className={styles.inner}>
        <Link to="/" className={styles.wordmark}>
          <FootballIcon className={styles.ball} />
          {APP_NAME}
        </Link>
        <nav aria-label="Main" className={styles.navWrap}>
          <ul className={styles.nav} role="list">
            <li>
              <NavLink
                to="/"
                end
                className={({ isActive }) => cx(styles.navLink, isActive && styles.active)}
              >
                Boards
              </NavLink>
            </li>
            {isAdmin && (
              <li>
                <NavLink
                  to="/admin"
                  className={({ isActive }) => cx(styles.navLink, isActive && styles.active)}
                >
                  Admin
                </NavLink>
              </li>
            )}
          </ul>
        </nav>
        <div className={styles.search}>
          <HeaderSearch />
        </div>
      </div>
    </header>
  );
}
