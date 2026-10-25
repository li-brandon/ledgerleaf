import { describe, expect, it } from 'vitest';
import { IMPORT_CSV_HREF, isPaletteKey, matchCommands, searchCommand } from '../commands';
import { ROUTES, SUBPAGES, parseRoute, routeHref } from '../routes';

describe('matchCommands', () => {
  it('lists every page, the CSV import and the themes when the query is blank', () => {
    const all = matchCommands('  ');
    for (const { id, label } of [...ROUTES, ...SUBPAGES]) expect(all).toContainEqual(expect.objectContaining({ label, href: routeHref(id) }));
    expect(all).toContainEqual(expect.objectContaining({ label: 'Import CSV', href: IMPORT_CSV_HREF }));
    expect(all.filter((c) => 'theme' in c).map((c) => c.label)).toEqual(['Theme: Light', 'Theme: Dark', 'Theme: Match system']);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
  });

  it('matches substrings of the label, ignoring case', () => {
    expect(matchCommands('BUDG').map((c) => c.label)).toEqual(['Budgets']);
    expect(matchCommands('rules').map((c) => c.label)).toEqual(['Categories & rules']);
    expect(matchCommands('dark').map((c) => c.label)).toEqual(['Theme: Dark']);
    expect(matchCommands('zzz')).toEqual([]);
  });

  it('opens the CSV import on Connections', () => {
    expect(parseRoute(IMPORT_CSV_HREF)).toEqual({ id: 'connections', params: { import: 'csv' } });
  });
});

describe('searchCommand', () => {
  it('searches transactions for the trimmed query', () => {
    const c = searchCommand('  coffee & tea ')!;
    expect(c.label).toBe('Search transactions for “coffee & tea”');
    expect(parseRoute((c as { href: string }).href)).toEqual({ id: 'transactions', params: { q: 'coffee & tea' } });
  });

  it('is absent for a blank query', () => {
    expect(searchCommand('')).toBeNull();
    expect(searchCommand('   ')).toBeNull();
  });
});

describe('isPaletteKey', () => {
  const key = (mods: Partial<Parameters<typeof isPaletteKey>[0]> = {}) =>
    ({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...mods });

  it('is ⌘K on a Mac and not Ctrl+K', () => {
    expect(isPaletteKey(key({ metaKey: true }), true)).toBe(true);
    expect(isPaletteKey(key({ metaKey: true, key: 'K' }), true)).toBe(true);
    expect(isPaletteKey(key({ ctrlKey: true }), true)).toBe(false);
  });

  it('is Ctrl+K elsewhere and not ⌘K', () => {
    expect(isPaletteKey(key({ ctrlKey: true }), false)).toBe(true);
    expect(isPaletteKey(key({ metaKey: true }), false)).toBe(false);
  });

  it('ignores held keys, IME composition, extra modifiers and other keys', () => {
    for (const isMac of [true, false]) {
      const mod = isMac ? { metaKey: true } : { ctrlKey: true };
      expect(isPaletteKey(key({ ...mod, repeat: true }), isMac)).toBe(false);
      expect(isPaletteKey(key({ ...mod, isComposing: true }), isMac)).toBe(false);
      expect(isPaletteKey(key({ ...mod, shiftKey: true }), isMac)).toBe(false);
      expect(isPaletteKey(key({ ...mod, altKey: true }), isMac)).toBe(false);
      expect(isPaletteKey(key({ ...mod, key: 'j' }), isMac)).toBe(false);
      expect(isPaletteKey(key(), isMac)).toBe(false);
    }
  });
});
