import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorState, LoadingNote } from './States';

/**
 * §48, and plan-search-engine Phase 4's accessibility pass: one `<h1>` per
 * page, including the states a page spends its first moments in. A page whose
 * whole content is "Loading…" still has a heading, and it is that line.
 */

const markup = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);

describe('a wait that IS the page', () => {
  const seen = markup(<LoadingNote isPage>Loading…</LoadingNote>);

  it('gives the page its one heading', () => {
    expect(seen.match(/<h1/g)).toHaveLength(1);
    expect(seen).toContain('Loading…');
  });

  it('keeps the heading a heading: the live region is the wrapper', () => {
    // `role="status"` on the <h1> would REPLACE its heading role, not add to
    // it, and the page would be heading-less again with nothing to show for it.
    expect(seen).toMatch(/<div role="status"><h1[^>]*>Loading…<\/h1><\/div>/);
  });
});

describe('a wait inside a page that already has a heading', () => {
  const seen = markup(<LoadingNote>Loading people…</LoadingNote>);

  it('is a plain announced line, and adds no second h1', () => {
    expect(seen).not.toContain('<h1');
    expect(seen).toContain('role="status"');
    expect(seen).toContain('Loading people…');
  });
});

describe('a failure that IS the page', () => {
  it('is announced, and its title is the page heading', () => {
    const seen = markup(<ErrorState title="Page not found" message="Nothing lives here." />);
    expect(seen).toContain('role="alert"');
    expect(seen.match(/<h1/g)).toHaveLength(1);
  });

  it('inside a section, steps down instead of adding a second h1', () => {
    const seen = markup(<ErrorState title="Schedule unavailable" headingLevel={3} />);
    expect(seen).not.toContain('<h1');
    expect(seen).toContain('<h3');
  });
});
