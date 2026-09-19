import { BOARD_TEAM_COUNT, type TeamIdentity } from '@cfb/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useId, useState, type RefObject } from 'react';
import { useAdminSession } from '../../auth/AdminSessionProvider';
import { TeamLogo } from '../../components/TeamLogo';
import { adminApi, queryKeys } from '../../lib/api';
import { isApiError } from '../../lib/apiClient';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import styles from './Admin.module.css';

/** Matches the API's minimum (`services/search.ts`): one letter matches half the country. */
const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;
/** The team list is cached for a day on the server; a result list is good for minutes here. */
const RESULTS_STALE_MS = 5 * 60_000;

interface TeamSearchProps {
  inputRef: RefObject<HTMLInputElement | null>;
  /** Provider ids already on the board: shown, but not addable (§3). */
  taken: ReadonlySet<string>;
  boardCount: number;
  /** The provider id being added right now, if any. */
  adding: string | null;
  onAdd: (team: TeamIdentity) => void;
}

/**
 * §43 — find a team by name and add it. Results come from the provider's own
 * team list, so a board always references a real provider identity, never
 * free text. Each result shows its logo and conference before it is chosen.
 */
export function TeamSearch({ inputRef, taken, boardCount, adding, onAdd }: TeamSearchProps) {
  const session = useAdminSession();
  const [text, setText] = useState('');
  const query = useDebouncedValue(text.trim(), DEBOUNCE_MS);
  const ready = query.length >= MIN_QUERY;
  const hintId = useId();

  const results = useQuery({
    queryKey: queryKeys.adminSearch(query.toLowerCase()),
    queryFn: ({ signal }) => adminApi.searchTeams(session.authHooks, query, signal),
    enabled: ready,
    staleTime: RESULTS_STALE_MS,
    // Keep the last results on screen while the next ones load: no flicker per keystroke.
    placeholderData: keepPreviousData,
  });

  const full = boardCount >= BOARD_TEAM_COUNT;

  return (
    <div className={styles.search}>
      <label className={styles.field}>
        <span>Find a team</span>
        <input
          ref={inputRef}
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={hintId}
        />
      </label>
      <p id={hintId} className={styles.hint}>
        Type at least {String(MIN_QUERY)} letters of a school, nickname, or abbreviation.
        {full &&
          ` This board has ${String(boardCount)} teams already. Adding more is allowed, but boards are designed for ${String(BOARD_TEAM_COUNT)}.`}
      </p>

      <div role="status" className={styles.searchStatus}>
        {!ready
          ? ''
          : results.isError
            ? ''
            : results.data === undefined
              ? 'Searching…'
              : results.data.teams.length === 0
                ? `No teams match “${query}”.`
                : `${String(results.data.teams.length)} ${results.data.teams.length === 1 ? 'team' : 'teams'} found.`}
      </div>

      {ready && results.isError && (
        <p className={styles.problemInline} role="alert">
          {results.error.message}
          {isApiError(results.error) && results.error.requestId !== null
            ? ` Reference: ${results.error.requestId}`
            : ''}
        </p>
      )}

      {ready && results.data !== undefined && results.data.teams.length > 0 && (
        <ul className={styles.results} role="list" aria-label="Search results">
          {results.data.teams.map((team) => {
            const label = team.displayName ?? team.name;
            const isTaken = taken.has(team.providerTeamId);
            const isAdding = adding === team.providerTeamId;
            return (
              <li key={team.providerTeamId} className={styles.result}>
                <TeamLogo
                  src={team.logoUrl}
                  name={team.name}
                  abbreviation={team.abbreviation}
                  size={40}
                  decorative
                />
                <span className={styles.rowText}>
                  <span className={styles.rowName}>{team.name}</span>{' '}
                  <span className={styles.rowMeta}>
                    {[team.conference ?? 'Conference unknown', team.abbreviation]
                      .filter((part): part is string => part !== null)
                      .join(' · ')}
                  </span>
                </span>
                {isTaken ? (
                  <span className={styles.taken}>On this board</span>
                ) : (
                  <button
                    type="button"
                    className="button"
                    aria-label={`Add ${label}`}
                    aria-disabled={adding !== null}
                    onClick={() => {
                      if (adding === null) onAdd(team);
                    }}
                  >
                    {isAdding ? 'Adding…' : 'Add'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
