import { Link, NavLink } from 'react-router';
import { useAdminSession } from '../auth/AdminSessionProvider';
import { cx } from '../lib/cx';
import { APP_NAME } from '../lib/useDocumentTitle';
import { FootballIcon } from './icons';
import styles from './AppHeader.module.css';

/**
 * The top bar. The Admin link appears only while an admin session exists;
 * `/login` is never linked and stays reachable by URL (plan §3.1). Hiding the
 * link protects nothing, and is not meant to: the database does (§31).
 */
export function AppHeader() {
  const { status } = useAdminSession();

  return (
    <header className={styles.bar}>
      <div className={styles.inner}>
        <Link to="/" className={styles.wordmark}>
          <FootballIcon className={styles.ball} />
          {APP_NAME}
        </Link>
        <nav aria-label="Main">
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
            {status === 'signed-in' && (
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
      </div>
    </header>
  );
}
