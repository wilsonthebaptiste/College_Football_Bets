import type { TeamIdentity, TeamOwner } from '@cfb/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { FromState } from '../../components/BackLink';
import { PickedBy } from '../../components/PickedBy';
import { TeamLogo } from '../../components/TeamLogo';
import { isApiError } from '../../lib/apiClient';
import { teamLabel } from '../../lib/format';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import { useTeamOwners } from '../../lib/useTeamOwners';
import styles from './SearchPage.module.css';
import { DEBOUNCE_MS, MIN_QUERY, useTeamSearch } from './useTeamSearch';

/**
 * Any team, not only the 54 on somebody's board (plan-search-engine, Phase 3).
 *
 * A plain list, deliberately: not a combobox. Typing filters, the results are
 * links, and the URL says what was searched, so a result page can be shared and
 * reloaded. The one keyboard behaviour is the browser's own — Tab to the input,
 * type, Tab into the results, Enter to open one.
 *
 * The input is NOT autofocused. `RootLayout` focuses `<main>` after every
 * navigation and parent effects run after child effects, so an autofocus here
 * would be stolen a moment later, silently. Being the first focusable element
 * inside `<main>` is what makes it one Tab away instead.
 */
export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = (searchParams.get('q') ?? '').trim();

  const [text, setText] = useState(urlQuery);
  const query = useDebouncedValue(text.trim(), DEBOUNCE_MS);
  const hintId = useId();

  useDocumentTitle(query === '' ? 'Search' : `Search: ${query}`);

  /**
   * What this page last put in `?q=`. A value that differs from it arrived from
   * somewhere else — the header's search box (Phase 4) navigating here while
   * this page is already mounted, or a history step — and that one wins.
   */
  const written = useRef(urlQuery);

  useEffect(() => {
    if (urlQuery !== written.current) {
      written.current = urlQuery;
      setText(urlQuery);
      return;
    }
    if (query === written.current) return;
    written.current = query;
    // `replace`, or every keystroke becomes a history entry and the back
    // button stops meaning "the page before this one".
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (query === '') next.delete('q');
        else next.set('q', query);
        return next;
      },
      { replace: true },
    );
  }, [query, urlQuery, setSearchParams]);

  const ready = query.length >= MIN_QUERY;
  const results = useTeamSearch(query);
  // A second, independent query: one request for the whole index per page
  // session, never one per keystroke, and never anything the results wait for.
  const ownersOf = useTeamOwners();
  const teams = results.data?.teams;
  // `keepPreviousData` leaves the last query's list on screen while the next
  // one loads, so "still searching" is placeholder data, not just no data.
  const searching = ready && (teams === undefined || results.isPlaceholderData);

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Search teams</h1>

      <form
        role="search"
        aria-label="Team search"
        className={styles.form}
        // Nothing to submit: the results are already live. Without this, Enter
        // in a single-input form reloads the page.
        onSubmit={(event) => event.preventDefault()}
      >
        <label className={styles.field}>
          <span>Find a team</span>
          <input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={hintId}
          />
        </label>
      </form>

      <p id={hintId} className={styles.hint}>
        Type at least {String(MIN_QUERY)} letters of a school, nickname, or abbreviation. Every team
        the provider lists is here, not only the ones on boards.
      </p>

      {/* Always present, so results arriving into it are announced (§48). */}
      <div role="status" className={styles.status}>
        {!ready || results.isError
          ? ''
          : searching
            ? 'Searching…'
            : teams !== undefined && teams.length > 0
              ? `${String(teams.length)} ${teams.length === 1 ? 'team' : 'teams'} found.`
              : `No teams match “${query}”.`}
      </div>

      {ready && results.isError && (
        <p className={styles.problem} role="alert">
          {results.error.message}
          {isApiError(results.error) && results.error.requestId !== null
            ? ` Reference: ${results.error.requestId}`
            : ''}
        </p>
      )}

      {ready && teams !== undefined && teams.length > 0 && (
        <ul className={styles.results} role="list" aria-label="Search results">
          {teams.map((team) => (
            // The owners are not in the key: they are what this row says about
            // the team, not which team it is.
            <li key={team.providerTeamId}>
              <ResultRow team={team} query={query} owners={ownersOf(team.providerTeamId)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What a result carries to the team page, so its back link reads "Search" and
 * returns to these exact results with the query intact. `readFromState` on the
 * other side accepts an in-app path only, which this always is.
 */
export function searchFrom(query: string): FromState {
  return { from: { path: `/search?q=${encodeURIComponent(query)}`, label: 'Search' } };
}

/**
 * One result: a card whose top line opens that team's page, keyed by the
 * PROVIDER's id (§Phase 1), because a team nobody has selected has no uuid.
 *
 * The link is the top line, not the whole card. Phase 3 made the entire row one
 * `<Link>` for the tap target; an owner's name inside it would be a link inside
 * a link — invalid HTML, and two targets fighting over one tap. Shrinking the
 * link to the line it names and putting `PickedBy` beside it inside the card
 * keeps both: a 44 px row for the team, and real links for the boards.
 *
 * The logo is decorative — the name is right beside it, so the link is
 * announced as "Alabama Crimson Tide, SEC · ALA, link" rather than with a
 * redundant "logo" in the middle of its name.
 */
function ResultRow({
  team,
  query,
  owners,
}: {
  team: TeamIdentity;
  query: string;
  owners: readonly TeamOwner[];
}) {
  const name = teamLabel(team);
  const state = searchFrom(query);
  const meta = [team.conference ?? 'Conference unknown', team.abbreviation]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <div className={styles.row}>
      <Link to={`/teams/${team.providerTeamId}`} state={state} className={styles.rowMain}>
        <TeamLogo
          src={team.logoUrl}
          name={name}
          abbreviation={team.abbreviation}
          size={40}
          decorative
        />
        <span className={styles.rowText}>
          <span className={styles.rowName}>{team.name}</span>
          <span className={styles.rowMeta}>{meta}</span>
        </span>
      </Link>
      <PickedBy owners={owners} />
    </div>
  );
}
