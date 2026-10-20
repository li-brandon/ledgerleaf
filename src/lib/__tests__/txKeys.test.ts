import { describe, expect, it } from 'vitest';
import { isTypingTarget, moveSelection, txKeyAction } from '../txKeys';

describe('isTypingTarget', () => {
  it('is true for text fields, selects and editable content', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTypingTarget({ tagName: 'input', type: 'search' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('is false for buttons, checkboxes and non-elements', () => {
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BODY' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });
});

describe('txKeyAction', () => {
  it('maps the list shortcuts', () => {
    expect(txKeyAction({ key: 'ArrowDown' })).toBe('next');
    expect(txKeyAction({ key: 'j' })).toBe('next');
    expect(txKeyAction({ key: 'ArrowUp' })).toBe('prev');
    expect(txKeyAction({ key: 'k' })).toBe('prev');
    expect(txKeyAction({ key: 'r' })).toBe('review');
    expect(txKeyAction({ key: 'c' })).toBe('category');
    expect(txKeyAction({ key: 'Escape' })).toBe('close');
    expect(txKeyAction({ key: 'x' })).toBeUndefined();
  });

  it('ignores keys typed into form fields', () => {
    for (const target of [{ tagName: 'INPUT', type: 'search' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }]) {
      expect(txKeyAction({ key: 'r', target })).toBeUndefined();
      expect(txKeyAction({ key: 'ArrowDown', target })).toBeUndefined();
    }
    expect(txKeyAction({ key: 'r', target: { tagName: 'BUTTON' } })).toBe('review');
  });

  it('ignores modified keys so browser shortcuts keep working', () => {
    expect(txKeyAction({ key: 'r', metaKey: true })).toBeUndefined();
    expect(txKeyAction({ key: 'c', ctrlKey: true })).toBeUndefined();
    expect(txKeyAction({ key: 'ArrowDown', altKey: true })).toBeUndefined();
  });
});

describe('moveSelection', () => {
  const ids = ['a', 'b', 'c'];

  it('moves and clamps at the ends', () => {
    expect(moveSelection(ids, 'a', 1)).toBe('b');
    expect(moveSelection(ids, 'b', -1)).toBe('a');
    expect(moveSelection(ids, 'c', 1)).toBe('c');
    expect(moveSelection(ids, 'a', -1)).toBe('a');
  });

  it('starts from the first or last row without a listed selection', () => {
    expect(moveSelection(ids, undefined, 1)).toBe('a');
    expect(moveSelection(ids, undefined, -1)).toBe('c');
    expect(moveSelection(ids, 'gone', 1)).toBe('a');
    expect(moveSelection([], 'a', 1)).toBeUndefined();
  });
});
