import { describe, expect, it } from 'vitest';
import { IMPORT_CSV_HREF, matchCommands, searchCommand } from '../commands';
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
