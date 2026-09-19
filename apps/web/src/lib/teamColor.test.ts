import { describe, expect, it } from 'vitest';
import { teamAccent } from './teamColor';

describe('teamAccent (§35: one visible 4 px rule per team)', () => {
  it('uses the primary colour when it shows in both themes', () => {
    expect(teamAccent('9e1b32', 'ffffff')).toEqual({ light: '#9e1b32', dark: '#9e1b32' });
  });

  it('falls back to the alternate where the primary would vanish', () => {
    // Navy disappears on the dark card; maize does not.
    expect(teamAccent('00274c', 'ffcb05')).toEqual({ light: '#00274c', dark: '#ffcb05' });
    // White disappears on the light card.
    expect(teamAccent('ffffff', 'ba0c2f')).toEqual({ light: '#ba0c2f', dark: '#ffffff' });
  });

  it('gives up (neutral rule) rather than drawing an invisible or bogus colour', () => {
    expect(teamAccent(null, null)).toEqual({ light: null, dark: null });
    expect(teamAccent('not-a-colour', '#123456')).toEqual({ light: null, dark: null });
    expect(teamAccent('061440', 'ffffff')).toEqual({ light: '#061440', dark: '#ffffff' });
  });
});
