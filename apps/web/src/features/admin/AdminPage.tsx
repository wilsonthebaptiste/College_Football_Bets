import { useNavigate } from 'react-router';
import { useAdminSession } from '../../auth/AdminSessionProvider';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import styles from './Admin.module.css';

/**
 * The admin console's shell. It renders only inside `RequireAdmin`, so by the
 * time it mounts the Worker has confirmed this session is an administrator.
 * Managing users and boards is Phase 5; until then this page proves the
 * session end to end (sign in, persist across reloads, sign out).
 */
export default function AdminPage() {
  useDocumentTitle('Admin');
  const session = useAdminSession();
  const navigate = useNavigate();

  const signOut = async () => {
    // Leave first: once the session ends, the guard around this page would
    // otherwise bounce to /login on the way out.
    await navigate('/', { replace: true });
    await session.signOut();
  };

  return (
    <div className={styles.narrow}>
      <h1 className={styles.title}>Admin</h1>
      <p className={styles.lede}>
        Signed in as <strong>{session.email ?? 'the administrator'}</strong>. The server confirmed
        this account is an administrator.
      </p>
      <p className={styles.note}>
        Managing people and their teams comes in a later update. Until then, boards are changed in
        the database directly.
      </p>
      <div>
        <button type="button" className="button-quiet" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </div>
  );
}
