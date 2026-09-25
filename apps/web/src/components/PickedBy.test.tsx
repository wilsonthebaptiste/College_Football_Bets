import { describe, expect, it } from 'vitest';
import { makeOwner } from '../test/fixtures';
import { renderInRouter, spokenText, visibleText } from '../test/render';
import { PickedBy } from './PickedBy';

/**
 * The line itself, away from any page that uses it (plan-search-engine, Phase
 * 6). Phase 7 puts the same component in a team page's hero, so what is pinned
 * here is the copy and the markup, once, for both.
 */

const WILSON = makeOwner('Wilson', '11111111-1111-4111-8111-111111111111');
const JORDAN = makeOwner('Jordan', '22222222-2222-4222-8222-222222222222');

/** An apostrophe in an attribute arrives escaped; a browser reads it as one character. */
const attribute = (text: string): string => text.replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

function anchors(markup: string): Array<{ href: string; label: string; text: string }> {
  return [...markup.matchAll(/<a([^>]*)>(.*?)<\/a>/g)].map(([, attrs = '', inner = '']) => ({
    href: attribute(/href="([^"]*)"/.exec(attrs)?.[1] ?? ''),
    label: attribute(/aria-label="([^"]*)"/.exec(attrs)?.[1] ?? ''),
    text: visibleText(inner),
  }));
}

describe('one board holds the team', () => {
  const markup = renderInRouter(<PickedBy owners={[WILSON]} />);

  it('says who has it, and opens their board', () => {
    expect(visibleText(markup)).toBe('Picked by Wilson');
    expect(anchors(markup)).toEqual([
      { href: `/u/${WILSON.userId}`, label: "Wilson's board", text: 'Wilson' },
    ]);
  });

  /**
   * 2.5.3, label in name: a voice user says what they see ("click Wilson"), so
   * the accessible name must contain the visible text. "Open board" would not.
   */
  it('names the link so its accessible name contains the visible name', () => {
    const [link] = anchors(markup);
    expect(link?.label).toContain(link?.text ?? '');
    expect(spokenText(markup)).toContain('Picked by');
  });
});

describe('two boards hold it', () => {
  // The order the server sends: `/api/selections` sorts by display name, and
  // this renders what it is given rather than sorting it a second time.
  const markup = renderInRouter(<PickedBy owners={[JORDAN, WILSON]} />);

  it('lists both, in the order the index gives them', () => {
    expect(anchors(markup).map((link) => link.text)).toEqual(['Jordan', 'Wilson']);
  });

  /**
   * No punctuation: a comma or a bullet between two links is read out with
   * them and copied with them. A space, though, is a real character — CSS
   * `gap` puts none in the text, so without it the line reads "Picked
   * byJordanWilson" to a screen reader and to anyone who copies it.
   */
  it('reads as a sentence: spaces between the names, and no punctuation', () => {
    expect(markup).not.toContain('</a>,');
    expect(markup).not.toContain('·');
    expect(visibleText(markup)).toBe('Picked by Jordan Wilson');
    expect(spokenText(markup)).toBe('Picked by Jordan Wilson');
  });
});

describe('nobody has it — the ordinary case for most of ~762 teams', () => {
  it('renders nothing at all: no label, and no empty element to style', () => {
    expect(renderInRouter(<PickedBy owners={[]} />)).toBe('');
  });
});
