import { describe, expect, it } from 'vitest';
import { boardSizeNote, moveItem, movedMessage, shortName } from './boardEdit';

describe('moveItem (plan §5.1: reorder with up and down)', () => {
  const board = ['ALA', 'UGA', 'TEX', 'MICH', 'USC', 'LSU'];

  it('moves one place up or down and leaves the rest in order', () => {
    expect(moveItem(board, 1, -1)).toEqual(['UGA', 'ALA', 'TEX', 'MICH', 'USC', 'LSU']);
    expect(moveItem(board, 1, 1)).toEqual(['ALA', 'TEX', 'UGA', 'MICH', 'USC', 'LSU']);
  });

  it('refuses to move past either end', () => {
    expect(moveItem(board, 0, -1)).toBeNull();
    expect(moveItem(board, 5, 1)).toBeNull();
    expect(moveItem(board, 9, -1)).toBeNull();
  });

  it('never mutates the list it was given', () => {
    const copy = [...board];
    moveItem(board, 2, -1);
    expect(board).toEqual(copy);
  });
});

describe('boardSizeNote (plan §5.1: warn above six)', () => {
  it('says nothing for exactly six', () => {
    expect(boardSizeNote(6)).toBeNull();
  });

  it('warns, in words, above six', () => {
    expect(boardSizeNote(7)).toEqual({
      tone: 'warn',
      text: 'This board has 7 teams. Boards are designed for 6, so the extra teams make it longer than the others.',
    });
  });

  it('counts down to six below it', () => {
    expect(boardSizeNote(4)?.text).toBe('This board has 4 of its 6 teams. Add 2 more.');
    expect(boardSizeNote(0)?.text).toBe('This board has no teams yet. Add 6.');
    expect(boardSizeNote(4)?.tone).toBe('info');
  });
});

describe('wording', () => {
  it('uses the short name a card shows, falling back to the full name', () => {
    expect(shortName({ displayName: 'Alabama', name: 'Alabama Crimson Tide' })).toBe('Alabama');
    expect(shortName({ displayName: null, name: 'Alabama Crimson Tide' })).toBe(
      'Alabama Crimson Tide',
    );
  });

  it('announces a move with the new position', () => {
    expect(movedMessage('Georgia', 1, 6)).toBe('Georgia moved to position 1 of 6.');
  });
});
