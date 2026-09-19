import { DISPLAY_NAME_MAX_LENGTH, type AdminUsersResponse, type UserSummary } from '@cfb/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAdminSession } from '../../auth/AdminSessionProvider';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorState, LoadingNote } from '../../components/States';
import { adminApi, queryKeys } from '../../lib/api';
import { isApiError } from '../../lib/apiClient';
import { initials } from '../../lib/format';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import styles from './Admin.module.css';
import { ProblemNote } from './ProblemNote';
import { problemOf, useAfterAdminWrite, useAnnouncer, type Problem } from './useAdminWrite';

const teamCount = (count: number): string => `${String(count)} ${count === 1 ? 'team' : 'teams'}`;

/**
 * The admin console (plan §5.1): the people who have boards. Add a person,
 * rename one, delete one, or open their board to change its teams.
 *
 * It renders only inside `RequireAdmin`, so the Worker has already confirmed
 * this session is an administrator. None of that is the boundary: every write
 * goes to Postgres with the administrator's own token, and RLS decides (§31).
 *
 * Adding a person creates no login, on purpose (plan §11.1): a person here is a
 * display name that owns a board.
 */
export default function AdminPage() {
  useDocumentTitle('Admin');
  const session = useAdminSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const afterWrite = useAfterAdminWrite();
  const [announcement, announce] = useAnnouncer();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<UserSummary | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  /** A selector to focus after the next render: an element that is about to be drawn. */
  const refocus = useRef<string | null>(null);

  // After every render: a pending focus target is drawn by now.
  useEffect(() => {
    const selector = refocus.current;
    if (selector === null) return;
    const target = document.querySelector<HTMLElement>(selector);
    if (target !== null) {
      target.focus();
      refocus.current = null;
    }
  });

  const users = useQuery({
    queryKey: queryKeys.adminUsers,
    queryFn: ({ signal }) => adminApi.users(session.authHooks, signal),
  });

  const create = useMutation({
    mutationFn: (displayName: string) => adminApi.createUser(session.authHooks, displayName),
    onSuccess: ({ user }) => {
      setProblem(null);
      announce(`${user.displayName} added. Open their board to add teams.`);
      afterWrite(null);
    },
    onError: (error) => setProblem(problemOf(error)),
  });

  const remove = useMutation({
    mutationFn: (user: UserSummary) => adminApi.deleteUser(session.authHooks, user.id),
    onSuccess: (_result, user) => {
      setProblem(null);
      // Off the list now, in the same render that closes the dialog, so focus
      // cannot land on the Delete button of someone who no longer exists.
      queryClient.setQueryData<AdminUsersResponse>(queryKeys.adminUsers, (old) =>
        old === undefined ? old : { users: old.users.filter((other) => other.id !== user.id) },
      );
      setDeleting(null);
      announce(`${user.displayName} and their board were deleted.`);
      afterWrite(user.id);
    },
    onError: (error) => {
      setDeleting(null);
      setProblem(problemOf(error));
    },
  });

  const signOut = async () => {
    // Leave first: once the session ends, the guard around this page would
    // otherwise bounce to /login on the way out.
    await navigate('/', { replace: true });
    await session.signOut();
  };

  const onCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const value = new FormData(form).get('displayName');
    const name = typeof value === 'string' ? value.trim() : '';
    if (name === '') {
      setProblem({ message: 'Enter a name.', requestId: null });
      addInputRef.current?.focus();
      return;
    }
    if (create.isPending) return;
    create.mutate(name, { onSuccess: () => form.reset() });
  };

  return (
    <div className={styles.console}>
      <header className={styles.consoleHeader}>
        <div>
          <h1 className={styles.title}>Admin</h1>
          <p className={styles.lede}>
            Signed in as <strong>{session.email ?? 'the administrator'}</strong>.
          </p>
        </div>
        <button type="button" className="button-quiet" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      {problem !== null && <ProblemNote problem={problem} onDismiss={() => setProblem(null)} />}

      <section className={styles.section} aria-labelledby="people-heading">
        <h2 id="people-heading" className={styles.sectionTitle} ref={headingRef} tabIndex={-1}>
          People
        </h2>

        <form className={styles.inlineForm} onSubmit={onCreate} noValidate>
          <label className={styles.field}>
            <span>Add a person</span>
            <input
              ref={addInputRef}
              name="displayName"
              type="text"
              autoComplete="off"
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              required
            />
          </label>
          <button type="submit" className="button" aria-disabled={create.isPending}>
            {create.isPending ? 'Adding…' : 'Add'}
          </button>
        </form>
        <p className={styles.hint}>
          Adding a person gives them a board. It creates no login: boards need no account.
        </p>

        {users.isPending ? (
          <LoadingNote>Loading people…</LoadingNote>
        ) : users.isError ? (
          <ErrorState
            headingLevel={3}
            title="Couldn't load people"
            message={users.error.message}
            requestId={isApiError(users.error) ? users.error.requestId : null}
            action={
              <button type="button" className="button" onClick={() => void users.refetch()}>
                Try again
              </button>
            }
          />
        ) : users.data.users.length === 0 ? (
          <p className={styles.hint}>Nobody yet. Add the first person above.</p>
        ) : (
          <ul className={styles.rows} role="list">
            {users.data.users.map((user) => (
              <li key={user.id} className={styles.row}>
                {renaming === user.id ? (
                  <RenameForm
                    user={user}
                    onDone={(renamedTo) => {
                      if (renamedTo !== null) {
                        setProblem(null);
                        // The new name now, not after the list is refetched.
                        queryClient.setQueryData<AdminUsersResponse>(queryKeys.adminUsers, (old) =>
                          old === undefined
                            ? old
                            : {
                                users: old.users.map((other) =>
                                  other.id === user.id
                                    ? { ...other, displayName: renamedTo }
                                    : other,
                                ),
                              },
                        );
                        announce(`${user.displayName} renamed to ${renamedTo}.`);
                        afterWrite(user.id);
                      }
                      // Back to this row's Rename button once the row is drawn again.
                      refocus.current = `[data-rename="${user.id}"]`;
                      setRenaming(null);
                    }}
                    onError={(error) => setProblem(problemOf(error))}
                  />
                ) : (
                  <PersonRow
                    user={user}
                    onRename={() => setRenaming(user.id)}
                    onDelete={() => setDeleting(user)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {deleting !== null && (
        <ConfirmDialog
          title={`Delete ${deleting.displayName}?`}
          message={`This removes ${deleting.displayName} and their board (${teamCount(deleting.teamCount)}) from the site. It can't be undone.`}
          confirmLabel="Delete"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting)}
          onCancel={() => setDeleting(null)}
          // Back to the Delete button that opened it; if the person is gone,
          // to the list's heading.
          returnFocus={() =>
            document.querySelector<HTMLButtonElement>(`[data-delete="${deleting.id}"]`) ??
            headingRef.current
          }
        />
      )}
    </div>
  );
}

function PersonRow({
  user,
  onRename,
  onDelete,
}: {
  user: UserSummary;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <span className={styles.monogram} aria-hidden="true">
        {initials(user.displayName)}
      </span>
      <span className={styles.rowText}>
        <span className={styles.rowName}>{user.displayName}</span>{' '}
        <span className={styles.rowMeta}>{teamCount(user.teamCount)}</span>
      </span>
      <span className={styles.rowActions}>
        <Link
          to={`/admin/u/${user.id}`}
          className="button"
          aria-label={`Edit board for ${user.displayName}`}
        >
          Edit board
        </Link>
        <button
          type="button"
          className="button-quiet"
          data-rename={user.id}
          aria-label={`Rename ${user.displayName}`}
          onClick={onRename}
        >
          Rename
        </button>
        <button
          type="button"
          className="button-quiet"
          data-delete={user.id}
          aria-label={`Delete ${user.displayName}`}
          onClick={onDelete}
        >
          Delete
        </button>
      </span>
    </>
  );
}

function RenameForm({
  user,
  onDone,
  onError,
}: {
  user: UserSummary;
  /** The new name, or `null` when cancelled. */
  onDone: (renamedTo: string | null) => void;
  onError: (error: unknown) => void;
}) {
  const session = useAdminSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const rename = useMutation({
    mutationFn: (displayName: string) =>
      adminApi.renameUser(session.authHooks, user.id, displayName),
  });

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const finish = (renamedTo: string | null) => onDone(renamedTo);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = inputRef.current?.value.trim() ?? '';
    if (name === '' || rename.isPending) return;
    if (name === user.displayName) {
      finish(null);
      return;
    }
    rename.mutate(name, {
      onSuccess: ({ user: renamed }) => finish(renamed.displayName),
      onError,
    });
  };

  return (
    <form
      className={styles.renameForm}
      onSubmit={onSubmit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') finish(null);
      }}
      noValidate
    >
      <label className={styles.field}>
        <span>New name for {user.displayName}</span>
        <input
          ref={inputRef}
          name="displayName"
          type="text"
          autoComplete="off"
          defaultValue={user.displayName}
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          required
        />
      </label>
      <span className={styles.rowActions}>
        <button type="submit" className="button" aria-disabled={rename.isPending}>
          {rename.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="button-quiet" onClick={() => finish(null)}>
          Cancel
        </button>
      </span>
    </form>
  );
}
