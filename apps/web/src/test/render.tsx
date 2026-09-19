import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';

/**
 * Component tests render to static markup: the real components, real router,
 * real query cache, and no DOM library. What they check is what a viewer
 * would see (or hear) for a given payload.
 */

export function renderAt(
  path: string,
  routePath: string,
  element: ReactNode,
  client?: QueryClient,
) {
  const queryClient = client ?? new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export function renderInRouter(element: ReactNode) {
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
}

function decode(text: string): string {
  return text
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Block boundaries become spaces; inline tags vanish, as they do on screen. */
function toText(markup: string): string {
  return decode(
    markup
      .replace(/<\/(p|h1|h2|h3|div|li|dt|dd|header|section|article|ul|dl|a|button)>/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/** The text a sighted viewer reads: screen-reader-only text removed. */
export function visibleText(markup: string): string {
  return toText(markup.replace(/<span class="visually-hidden">[^<]*<\/span>/g, ''));
}

/** The text a screen reader announces: `aria-hidden` text removed. */
export function spokenText(markup: string): string {
  return toText(markup.replace(/<span aria-hidden="true">[^<]*<\/span>/g, ''));
}

/** §37 — nothing may ever render a raw placeholder value. */
export const RAW_VALUE = /\b(undefined|NaN|null)\b|\[object Object\]|Invalid Date/;
