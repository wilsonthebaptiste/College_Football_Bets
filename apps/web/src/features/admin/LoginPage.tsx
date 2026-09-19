import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { useAdminSession } from '../../auth/AdminSessionProvider';
import { ErrorState, LoadingNote } from '../../components/States';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import styles from './Admin.module.css';

/** Only an in-app path may follow sign-in; anything else goes to the console. */
export function safeNext(raw: string | null): string {
  if (raw === null || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return '/admin';
  }
  return raw;
}

/**
 * Administrator sign-in (§29). Reachable by URL and never linked: viewers have
 * no account and no reason to be here (plan §11.1). Opening this page is what
 * loads the auth library, not visiting the rest of the site.
 */
export default function LoginPage() {
  useDocumentTitle('Admin sign-in');
  const session = useAdminSession();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const { configured, prepare } = session;
  useEffect(() => {
    // Warm the auth chunk while the admin types.
    if (configured) prepare().catch(() => undefined);
  }, [configured, prepare]);

  useEffect(() => {
    if (error !== null) errorRef.current?.focus();
  }, [error]);

  if (!configured) {
    return (
      <ErrorState
        title="Admin sign-in isn't set up"
        message="This build has no Supabase settings. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to apps/web/.env, then restart the dev server."
      />
    );
  }

  if (session.status === 'signed-in') return <Navigate to={next} replace />;
  if (session.status === 'checking') return <LoadingNote>Checking your session…</LoadingNote>;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string): string => {
      const value = form.get(name);
      return typeof value === 'string' ? value : '';
    };
    const email = text('email').trim();
    const password = text('password');
    if (email === '' || password === '') {
      setError('Enter your email and password.');
      return;
    }

    setSubmitting(true);
    setError(null);
    const message = await session.signIn(email, password);
    setSubmitting(false);
    // Success needs no navigation here: the session change re-renders this
    // page, and the `signed-in` branch above redirects to `next`.
    if (message !== null) setError(message);
  };

  return (
    <div className={styles.narrow}>
      <h1 className={styles.title}>Admin sign-in</h1>
      <p className={styles.lede}>For the administrator only. Boards need no account.</p>

      <form className={styles.form} onSubmit={(event) => void onSubmit(event)} noValidate>
        {error !== null && (
          <p className={styles.formError} role="alert" tabIndex={-1} ref={errorRef}>
            {error}
          </p>
        )}
        <label className={styles.field}>
          <span>Email</span>
          <input
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            aria-invalid={error !== null}
          />
        </label>
        <label className={styles.field}>
          <span>Password</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={error !== null}
          />
        </label>
        <button type="submit" className="button" aria-disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
