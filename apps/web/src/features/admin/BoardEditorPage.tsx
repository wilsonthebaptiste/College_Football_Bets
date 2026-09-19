import type { AdminBoardResponse, TeamIdentity, UserTeamSelection } from '@cfb/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAdminSession } from '../../auth/AdminSessionProvider';
import { BackLink } from '../../components/BackLink';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ArrowIcon } from '../../components/icons';
import { ErrorState, LoadingNote } from '../../components/States';
import { TeamLogo } from '../../components/TeamLogo';
import { adminApi, queryKeys } from '../../lib/api';
import { isApiError } from '../../lib/apiClient';
import { cx } from '../../lib/cx';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import styles from './Admin.module.css';
import { boardSizeNote, moveItem, movedMessage, onBoard, shortName } from './boardEdit';
import { ProblemNote } from './ProblemNote';
import { TeamSearch } from './TeamSearch';
import { problemOf, useAfterAdminWrite, useAnnouncer, type Problem } from './useAdminWrite';

type Direction = 'up' | 'down';

/**
 * One person's board (plan §5.1): the teams in order, with Up, Down, and
 * Remove on each, and a search to add more.
 *
 * Every change is one request, and the server answers with the whole board as
 * it now stands, which replaces what is shown. A reorder is one `PUT` of the
 * complete order, applied by `reorder_selections` in one transaction (§44).
 * The order is shown moved at once; if the server refuses, the page shows the
 * board as the server holds it.
 */
export default function BoardEditorPage() {
  const { userId = '' } = useParams();
  const session = useAdminSession();
  const queryClient = useQueryClient();
  const afterWrite = useAfterAdminWrite();
  const [announcement, announce] = useAnnouncer();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [removing, setRemoving] = useState<UserTeamSelection | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** Where focus goes once a move has re-rendered the list (see the effect below). */
  const pendingFocus = useRef<{ id: string; direction: Direction } | null>(null);

  const key = queryKeys.adminBoard(userId);
  const board = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => adminApi.board(session.authHooks, userId, signal),
  });
  const name = board.data?.user.displayName ?? null;
  useDocumentTitle(name === null ? 'Edit board' : `${name}'s board`);

  const show = (selections: UserTeamSelection[]) =>
    queryClient.setQueryData<AdminBoardResponse>(key, (old) =>
      old === undefined ? old : { ...old, selections },
    );

  // Reordering is a save queue, not a mutation per press. Each press moves the
  // row at once; the latest order is what gets saved; presses made while a
  // save is in flight are sent together when it lands. So pressing Up twice
  // quickly moves the team twice, and the requests can never arrive out of
  // order and leave the board in an older arrangement.
  const nextOrder = useRef<UserTeamSelection[] | null>(null);
  const saving = useRef(false);
  const [savingOrder, setSavingOrder] = useState(false);

  /** Settles when the save queue is empty. Adding or removing waits for it. */
  const orderSaved = useRef<Promise<void>>(Promise.resolve());

  const saveOrder = () => {
    if (saving.current) return;
    saving.current = true;
    setSavingOrder(true);
    orderSaved.current = (async () => {
      try {
        while (nextOrder.current !== null) {
          const order = nextOrder.current;
          nextOrder.current = null;
          const { selections: saved } = await adminApi.reorder(
            session.authHooks,
            userId,
            order.map((selection) => selection.id),
          );
          // Only the last answer is shown; earlier ones are already out of date.
          if (nextOrder.current === null) show(saved);
        }
        setProblem(null);
        afterWrite(userId);
      } catch (error) {
        nextOrder.current = null;
        setProblem(problemOf(error));
        // Show what the server actually holds, rather than guess what to undo.
        void queryClient.invalidateQueries({ queryKey: key });
      } finally {
        saving.current = false;
        setSavingOrder(false);
      }
    })();
  };

  const add = useMutation({
    mutationFn: (team: TeamIdentity) =>
      adminApi.addSelection(session.authHooks, userId, team.providerTeamId),
    onSuccess: ({ selections, selection }) => {
      setProblem(null);
      show(selections);
      announce(
        `${shortName(selection.team)} added in position ${String(selection.order)} of ${String(selections.length)}.`,
      );
      afterWrite(userId);
    },
    onError: (error) => setProblem(problemOf(error)),
  });

  const remove = useMutation({
    mutationFn: (selection: UserTeamSelection) =>
      adminApi.removeSelection(session.authHooks, selection.id),
    onSuccess: ({ selections }, removed) => {
      setProblem(null);
      setRemoving(null);
      show(selections);
      announce(`${shortName(removed.team)} removed. ${String(selections.length)} teams left.`);
      afterWrite(userId);
    },
    onError: (error) => {
      setRemoving(null);
      setProblem(problemOf(error));
    },
  });

  /**
   * An add or remove from the moment it is asked for, including any wait for a
   * pending order save (`orderSaved`), until the server answers. The board is
   * about to change shape, so no other change may start meanwhile; a second
   * press of the same button does nothing.
   */
  const [queued, setQueued] = useState<'add' | 'remove' | null>(null);
  const queuedRef = useRef(false);
  const changing = queued !== null || add.isPending || remove.isPending;

  const afterOrderSaved = (kind: 'add' | 'remove', work: (done: () => void) => void) => {
    if (queuedRef.current) return;
    queuedRef.current = true;
    setQueued(kind);
    const done = () => {
      queuedRef.current = false;
      setQueued(null);
    };
    void orderSaved.current.then(() => work(done));
  };

  // After a move the row's DOM node is re-inserted, which drops focus. Put it
  // back on the same row: the same button, or the other one if this row just
  // reached the end of the list and that button is now disabled.
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    const button = (direction: Direction) =>
      document.querySelector<HTMLButtonElement>(
        `[data-move="${target.id}"][data-direction="${direction}"]`,
      );
    const same = button(target.direction);
    const other = button(target.direction === 'up' ? 'down' : 'up');
    (same !== null && !same.disabled ? same : other)?.focus();
    pendingFocus.current = null;
  });

  if (board.isPending) return <LoadingNote>Loading the board…</LoadingNote>;

  if (board.isError) {
    const error = board.error;
    const missing = isApiError(error) && error.kind === 'not_found';
    return (
      <div className={styles.console}>
        <BackLink to="/admin" label="Admin" />
        <ErrorState
          title={missing ? 'No such person' : "Couldn't load this board"}
          message={
            missing ? 'This person may have been deleted. Go back to the list.' : error.message
          }
          requestId={isApiError(error) ? error.requestId : null}
          {...(missing
            ? {}
            : {
                action: (
                  <button type="button" className="button" onClick={() => void board.refetch()}>
                    Try again
                  </button>
                ),
              })}
        />
      </div>
    );
  }

  const { user, selections } = board.data;
  const note = boardSizeNote(selections.length);

  const move = (selectionId: string, direction: Direction) => {
    if (changing) return;
    // The cache, not this render's copy: a second press can land before a re-render.
    const current = queryClient.getQueryData<AdminBoardResponse>(key)?.selections ?? selections;
    const index = current.findIndex((selection) => selection.id === selectionId);
    const moved = moveItem(current, index, direction === 'up' ? -1 : 1);
    const selection = current[index];
    if (moved === null || selection === undefined) return;

    show(moved.map((item, position) => ({ ...item, order: position + 1 })));
    pendingFocus.current = { id: selection.id, direction };
    const position = index + (direction === 'up' ? 0 : 2);
    announce(movedMessage(shortName(selection.team), position, current.length));
    nextOrder.current = moved;
    saveOrder();
  };

  return (
    <div className={styles.console}>
      <BackLink to="/admin" label="Admin" />
      <header className={styles.consoleHeader}>
        <div>
          <h1 className={styles.title}>{user.displayName}'s board</h1>
          <p className={styles.lede}>
            Teams show on the board in this order. <Link to={`/u/${user.id}`}>View the board</Link>
          </p>
        </div>
      </header>

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      {problem !== null && <ProblemNote problem={problem} onDismiss={() => setProblem(null)} />}

      <section className={styles.section} aria-labelledby="teams-heading">
        <div className={styles.sectionHead}>
          <h2 id="teams-heading" className={styles.sectionTitle} ref={listHeadingRef} tabIndex={-1}>
            Teams
          </h2>
          {/* Visual only: the live region has already said what moved. */}
          {savingOrder && (
            <span className={styles.saving} aria-hidden="true">
              Saving the order…
            </span>
          )}
        </div>
        {note !== null && (
          <p className={cx(styles.sizeNote, note.tone === 'warn' && styles.sizeWarn)}>
            {note.text}
          </p>
        )}
        {selections.length > 0 && (
          <ol className={styles.selections} role="list">
            {selections.map((selection, index) => {
              const teamName = shortName(selection.team);
              return (
                <li key={selection.id} className={styles.selection}>
                  <span className={styles.position} aria-hidden="true">
                    {String(index + 1)}
                  </span>
                  <TeamLogo
                    src={selection.team.logoUrl}
                    name={selection.team.name}
                    abbreviation={selection.team.abbreviation}
                    size={40}
                    decorative
                  />
                  <span className={styles.rowText}>
                    <span className={styles.rowName}>
                      <span className="visually-hidden">{`${String(index + 1)}. `}</span>
                      {teamName}
                    </span>{' '}
                    {selection.team.conference !== null && (
                      <span className={styles.rowMeta}>{selection.team.conference}</span>
                    )}
                  </span>
                  <span className={styles.rowActions}>
                    <button
                      type="button"
                      className={cx('button-quiet', styles.iconButton)}
                      data-move={selection.id}
                      data-direction="up"
                      aria-label={`Move ${teamName} up`}
                      disabled={index === 0}
                      aria-disabled={changing}
                      onClick={() => move(selection.id, 'up')}
                    >
                      <ArrowIcon direction="up" />
                      <span aria-hidden="true">Up</span>
                    </button>
                    <button
                      type="button"
                      className={cx('button-quiet', styles.iconButton)}
                      data-move={selection.id}
                      data-direction="down"
                      aria-label={`Move ${teamName} down`}
                      disabled={index === selections.length - 1}
                      aria-disabled={changing}
                      onClick={() => move(selection.id, 'down')}
                    >
                      <ArrowIcon direction="down" />
                      <span aria-hidden="true">Down</span>
                    </button>
                    <button
                      type="button"
                      className="button-quiet"
                      data-remove={selection.id}
                      aria-label={`Remove ${teamName}`}
                      aria-disabled={changing}
                      onClick={() => {
                        if (!changing) setRemoving(selection);
                      }}
                    >
                      Remove
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className={styles.section} aria-labelledby="add-heading">
        <h2 id="add-heading" className={styles.sectionTitle}>
          Add a team
        </h2>
        <TeamSearch
          inputRef={searchRef}
          taken={onBoard(selections)}
          boardCount={selections.length}
          adding={addingId}
          onAdd={(team) => {
            if (changing) return;
            setAddingId(team.providerTeamId);
            afterOrderSaved('add', (done) =>
              add.mutate(team, {
                onSettled: () => {
                  done();
                  setAddingId(null);
                  // The Add button becomes "On this board"; carry on searching.
                  searchRef.current?.focus();
                },
              }),
            );
          }}
        />
      </section>

      {removing !== null && (
        <ConfirmDialog
          title={`Remove ${shortName(removing.team)}?`}
          message={`${shortName(removing.team)} comes off ${user.displayName}'s board. You can add it again later.`}
          confirmLabel="Remove"
          busy={queued === 'remove' || remove.isPending}
          onConfirm={() =>
            afterOrderSaved('remove', (done) => remove.mutate(removing, { onSettled: done }))
          }
          onCancel={() => setRemoving(null)}
          // Back to the Remove button that opened it; if the team is gone, to
          // the list's heading.
          returnFocus={() =>
            document.querySelector<HTMLButtonElement>(`[data-remove="${removing.id}"]`) ??
            listHeadingRef.current
          }
        />
      )}
    </div>
  );
}
