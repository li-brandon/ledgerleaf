/** Keyboard shortcuts for the transactions list. Pure, so it can be unit tested. */

export type TxKeyAction = 'next' | 'prev' | 'review' | 'category' | 'close';

/** Minimal shape of a keyboard event, so tests need no DOM. */
export interface KeyLike {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  target?: unknown;
}

interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  type?: string;
}

/** Input types that do not take text, so shortcuts still work while they have focus. */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset']);

/** Whether keys typed at `target` belong to a form field (text input, textarea, select, editable content). */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as ElementLike;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && !NON_TEXT_INPUTS.has((el.type ?? 'text').toLowerCase());
}

/**
 * The list action for a key press, or undefined to let the browser handle it: ↑/↓ (and
 * k/j) move the selection, `r` toggles reviewed, `c` opens the category picker and Escape
 * closes the detail. Keys typed into form fields and modified keys are ignored.
 */
export function txKeyAction(e: KeyLike): TxKeyAction | undefined {
  if (e.altKey || e.ctrlKey || e.metaKey || isTypingTarget(e.target)) return undefined;
  switch (e.key) {
    case 'ArrowDown': case 'j': return 'next';
    case 'ArrowUp': case 'k': return 'prev';
    case 'r': case 'R': return 'review';
    case 'c': case 'C': return 'category';
    case 'Escape': return 'close';
    default: return undefined;
  }
}

/**
 * The id `delta` rows from `current` in `ids`, clamped to the ends. With nothing selected
 * (or a selection no longer listed), moving down picks the first row and up the last.
 */
export function moveSelection(ids: readonly string[], current: string | undefined, delta: number): string | undefined {
  if (!ids.length) return undefined;
  const i = current === undefined ? -1 : ids.indexOf(current);
  if (i < 0) return delta > 0 ? ids[0] : ids[ids.length - 1];
  return ids[Math.min(ids.length - 1, Math.max(0, i + delta))];
}
