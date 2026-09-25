import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import styles from './HeaderSearch.module.css';

/**
 * Where a submitted query goes. Exported because router navigation never
 * reaches the markup the component tests read, so this is where "Enter opens
 * the results for what was typed" can actually be asserted — the same reason
 * `SearchPage` exports `searchFrom`.
 *
 * An empty box still opens `/search`, with no `?q=`: the page there is the
 * hint and an empty input, which is a better answer to "search" than a control
 * that quietly does nothing.
 */
export function searchPath(text: string): string {
  const query = text.trim();
  return query === '' ? '/search' : `/search?q=${encodeURIComponent(query)}`;
}

/**
 * The search box in the header, on every page (plan-search-engine, Phase 4).
 *
 * It navigates; it does not suggest. No dropdown over every page: that is a
 * combobox, and the app has deliberately avoided combobox keyboard handling
 * (plan-search-engine, "Decisions taken with the owner"). A results page is a
 * URL instead — shareable, reloadable, and something the back button
 * understands.
 *
 * Submitting clears the box, so the two inputs can never disagree. From
 * `/search` itself a submit is a param change rather than a remount, and
 * `SearchPage` treats any `?q=` it did not write as the source of truth
 * (Phase 3); an emptied box has nothing left to contradict it with.
 *
 * Never autofocused. This is on every page, so an autofocus here would take
 * the caret away from whatever the visitor actually came for.
 */
export function HeaderSearch() {
  const navigate = useNavigate();
  const [text, setText] = useState('');

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const path = searchPath(text);
    setText('');
    void navigate(path);
  }

  return (
    <form role="search" aria-label="Site search" className={styles.form} onSubmit={onSubmit}>
      <label className={styles.field}>
        {/* The page at /search has its own visible label; here the placeholder
            carries the affordance and this carries the accessible name. The
            two landmarks are labelled apart: "Site search" and "Team search". */}
        <span className="visually-hidden">Search teams</span>
        <input
          className={styles.input}
          type="search"
          placeholder="Search teams"
          value={text}
          onChange={(event) => setText(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <button type="submit" className={styles.submit}>
        Search
      </button>
    </form>
  );
}
