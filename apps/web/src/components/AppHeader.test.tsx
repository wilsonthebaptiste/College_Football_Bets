import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchPage } from '../features/search/SearchPage';
import { renderAt, renderInRouter, visibleText } from '../test/render';
import { AppHeader } from './AppHeader';
import { searchPath } from './HeaderSearch';

/**
 * Phase 3's Level C finding, fixed in Phase 5: the header showed an Admin link
 * to any signed-in account. It now waits for the Worker to confirm the account
 * is an administrator (`GET /api/admin/session` → 200).
 *
 * Phase 4 of plan-search-engine adds the search box, which is why the two
 * exact-text assertions below now end in "Search". They are exact on purpose:
 * they say these are the ONLY things in the header, so anything new has to be
 * added here deliberately.
 */

type Status = 'signed-out' | 'checking' | 'signed-in';
const state = vi.hoisted((): { status: Status; confirmed: boolean } => ({
  status: 'signed-out',
  confirmed: false,
}));

vi.mock('../auth/AdminSessionProvider', () => ({
  useAdminSession: () => ({ status: state.status }),
}));
vi.mock('../auth/useAdminCheck', () => ({
  useAdminCheck: () => ({ isSuccess: state.confirmed }),
}));

beforeEach(() => {
  state.status = 'signed-out';
  state.confirmed = false;
});

const header = () => renderInRouter(<AppHeader />);
const links = () => visibleText(header());

describe('the header Admin link', () => {
  it('is absent for a viewer', () => {
    expect(links()).not.toContain('Admin');
  });

  it('is absent for a signed-in account the server has not confirmed', () => {
    state.status = 'signed-in';
    expect(links()).not.toContain('Admin');
  });

  it('is absent for a signed-in non-administrator (403)', () => {
    state.status = 'signed-in';
    state.confirmed = false;
    expect(links()).toBe('CFB Board Boards Search');
  });

  it('appears once the server confirms an administrator', () => {
    state.status = 'signed-in';
    state.confirmed = true;
    expect(links()).toBe('CFB Board Boards Admin Search');
  });
});

describe('the header search box (plan-search-engine, Phase 4)', () => {
  it('is a search landmark, labelled apart from the one on /search', () => {
    const markup = header();
    expect(markup).toContain('role="search"');
    expect(markup).toContain('aria-label="Site search"');
    // The page's own landmark; two identical labels would be two landmarks a
    // screen reader cannot tell apart.
    expect(markup).not.toContain('aria-label="Team search"');
  });

  it('is a plain box and a button, never a combobox', () => {
    const markup = header();
    expect(markup).toContain('type="search"');
    expect(markup).toContain('type="submit"');
    expect(markup).not.toContain('role="combobox"');
    expect(markup).not.toContain('aria-autocomplete');
    expect(markup).not.toContain('aria-activedescendant');
  });

  it('has an accessible name, and does not take focus on every page', () => {
    const markup = header();
    expect(markup).toContain('<span class="visually-hidden">Search teams</span>');
    expect(markup).not.toContain('autofocus');
    expect(markup).not.toContain('autoFocus');
  });

  it('starts empty on every page, whatever is in the URL', () => {
    expect(header()).toContain('value=""');
  });
});

describe('where the header search goes', () => {
  it('opens the results for what was typed', () => {
    expect(searchPath('texas')).toBe('/search?q=texas');
  });

  it('trims and encodes rather than pasting into a URL', () => {
    expect(searchPath('  Texas A&M  ')).toBe('/search?q=Texas%20A%26M');
  });

  it('opens the search page itself when the box is empty', () => {
    expect(searchPath('   ')).toBe('/search');
  });

  it('lands on a page that reads the query back out of the URL', () => {
    // The round trip the header depends on: what it navigates to is what
    // `SearchPage` seeds its own input from (Phase 3's two-way URL sync).
    const markup = renderAt(searchPath('texas a&m'), '/search', <SearchPage />, new QueryClient());
    expect(markup).toContain('value="texas a&amp;m"');
  });
});
