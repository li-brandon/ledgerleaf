import { describe, expect, it } from 'vitest';
import { defaultCategories } from '../categories';
import { DEFAULT_BUDGETS, migrate, migrateV1, type LedgerStateV1 } from '../migrate';
import { SCHEMA_VERSION } from '../types';

const MONTH = '2026-10';

const v1: LedgerStateV1 = {
  accounts: [
    { id: 'demo-checking', name: 'Fernway Checking', type: 'checking', balance: 4210.55 },
    { id: 'csv-imported', name: 'Imported', type: 'checking' },
  ],
  transactions: [
    { id: 'mock-a1', date: '2026-10-02', description: 'Green Basket Market', amount: -80, category: 'Groceries', accountId: 'demo-checking' },
    { id: 'mock-a2', date: '2026-10-01', description: 'Brightwater Payroll', amount: 2900, category: 'Income', accountId: 'demo-checking' },
    { id: 'csv-b1', date: '2026-09-30', description: 'Bean There', amount: -4.5, category: 'Coffee Shops', accountId: 'csv-imported' },
  ],
  budgets: { Groceries: 400, Dining: 120 },
  lastSync: '2026-10-19T12:00:00.000Z',
};

describe('migrate', () => {
  it('returns an empty v2 ledger with seed categories and default budgets', () => {
    for (const raw of [null, undefined, 'garbage', {}]) {
      const s = migrate(raw, MONTH);
      expect(s.version).toBe(SCHEMA_VERSION);
      expect(s.accounts).toEqual([]);
      expect(s.transactions).toEqual([]);
      expect(s.rules).toEqual([]);
      expect(s.balanceSnapshots).toEqual([]);
      expect(s.categories).toEqual(defaultCategories());
      expect(s.budgets).toHaveLength(Object.keys(DEFAULT_BUDGETS).length);
      expect(s.budgets.every((b) => b.month === MONTH && !b.rollover)).toBe(true);
    }
  });

  it('seeds categories with Income and Transfer excluded from spend', () => {
    const cats = defaultCategories();
    expect(cats.map((c) => c.name)).toContain('Groceries');
    expect(cats.filter((c) => c.excludeFromSpend).map((c) => c.id).sort()).toEqual(['income', 'transfer']);
    for (const c of cats) expect(c).toMatchObject({ group: expect.any(String), color: expect.any(String), icon: expect.any(String) });
  });

  it('migrates a full v1 ledger', () => {
    const s = migrate(v1, MONTH);
    expect(s.lastSync).toBe(v1.lastSync);
    expect(s.accounts[0]).toEqual({ ...v1.accounts![0], currency: 'USD', hidden: false });
    expect(s.transactions[0]).toEqual({
      ...v1.transactions![0], categoryId: 'groceries', merchant: 'Green Basket Market', reviewed: false, source: 'mock',
    });
    expect(s.transactions[1]).toMatchObject({ category: 'Income', categoryId: 'income' });
    expect(s.transactions[2]).toMatchObject({ source: 'csv' });
  });

  it('converts the legacy budgets map to monthly Budget records', () => {
    expect(migrate(v1, MONTH).budgets).toEqual([
      { id: 'groceries:2026-10', categoryId: 'groceries', month: MONTH, amount: 400, rollover: false },
      { id: 'dining:2026-10', categoryId: 'dining', month: MONTH, amount: 120, rollover: false },
    ]);
    expect(migrateV1({ budgets: {} }, MONTH).budgets).toEqual([]);
    expect(migrateV1({ budgets: { Pets: 40, Bad: 'x' as unknown as number } }, MONTH).budgets)
      .toEqual([{ id: 'pets:2026-10', categoryId: 'pets', month: MONTH, amount: 40, rollover: false }]);
  });

  it('creates custom categories for unknown names', () => {
    const s = migrate(v1, MONTH);
    expect(s.transactions[2]).toMatchObject({ category: 'Coffee Shops', categoryId: 'coffee-shops' });
    expect(s.categories.find((c) => c.id === 'coffee-shops'))
      .toEqual({ id: 'coffee-shops', name: 'Coffee Shops', group: 'Custom', color: expect.any(String), icon: expect.any(String), excludeFromSpend: false });
    expect(s.categories).toHaveLength(defaultCategories().length + 1);
  });

  it('matches known categories case-insensitively and maps blank ones to Other', () => {
    const s = migrateV1({
      transactions: [
        { id: '1', date: '2026-10-01', description: 'x', amount: -1, category: 'dining', accountId: 'a' },
        { id: '2', date: '2026-10-01', description: 'y', amount: -1, category: '', accountId: 'a' },
      ],
      budgets: {},
    }, MONTH);
    expect(s.transactions.map((t) => [t.category, t.categoryId])).toEqual([['Dining', 'dining'], ['Other', 'other']]);
    expect(s.categories).toHaveLength(defaultCategories().length);
  });

  it('is idempotent and survives a JSON round trip', () => {
    const once = migrate(v1, MONTH);
    expect(migrate(once, '2027-01')).toEqual(once);
    expect(migrate(JSON.parse(JSON.stringify(once)), MONTH)).toEqual(once);
  });

  it('keeps valid CSV import mappings and drops malformed ones', () => {
    const s = migrate({
      ...migrate(v1, MONTH),
      importMappings: {
        a: { date: 'Date', description: 'Memo', debit: 'Out', negate: true, junk: 1 },
        b: { date: 'Date' },
        c: 'nope',
      },
    } as never, MONTH);
    expect(s.importMappings).toEqual({ a: { date: 'Date', description: 'Memo', debit: 'Out', negate: true } });
    expect(migrate(v1, MONTH).importMappings).toBeUndefined();
  });

  it('keeps a CSV mapping\'s decimal separator through a round trip and drops invalid ones', () => {
    const s = migrate({
      ...migrate(v1, MONTH),
      importMappings: {
        eu: { date: 'Datum', description: 'Text', amount: 'Belopp', decimal: ',' },
        us: { date: 'Date', description: 'Memo', amount: 'Amount', decimal: '.' },
        bad: { date: 'Date', description: 'Memo', amount: 'Amount', decimal: ';' },
      },
    } as never, MONTH);
    expect(s.importMappings).toEqual({
      eu: { date: 'Datum', description: 'Text', amount: 'Belopp', decimal: ',' },
      us: { date: 'Date', description: 'Memo', amount: 'Amount', decimal: '.' },
      bad: { date: 'Date', description: 'Memo', amount: 'Amount' },
    });
    expect(migrate(JSON.parse(JSON.stringify(s)), MONTH)).toEqual(s);
  });

  it('fills fields missing from stored categories and keeps the exclude flag the user set', () => {
    const base = migrate(v1, MONTH);
    const s = migrate({
      ...base,
      categories: [
        { id: 'income', name: 'Income' },
        { id: 'dining', name: 'Dining', group: 'Lifestyle', color: '#d9822b', icon: '🍽️', excludeFromSpend: true },
        { id: 'dining', name: 'Duplicate' },
        { name: 'No id' },
      ],
    } as never, MONTH);
    expect(s.categories.slice(0, 2)).toEqual([
      { id: 'income', name: 'Income', group: 'Custom', color: '#a0a4ab', icon: '•', excludeFromSpend: true },
      { id: 'dining', name: 'Dining', group: 'Lifestyle', color: '#d9822b', icon: '🍽️', excludeFromSpend: true },
    ]);
    expect(s.categories.filter((c) => c.id === 'dining')).toHaveLength(1);
  });

  it('keeps well-formed rules in order and drops broken ones', () => {
    const base = migrate(v1, MONTH);
    const s = migrate({
      ...base,
      rules: [
        { id: 'b', categoryId: 'dining', merchantRegex: '^cafe', amountEquals: -5, renameMerchant: 'Cafe', junk: true },
        { id: 'a', categoryId: 'deleted-category', merchant: 'x' },
        { categoryId: 'dining', merchant: 'no id' },
        { id: 'c', categoryId: 'rent', descriptionContains: 'landlord', amountMin: 'big' },
      ],
    } as never, MONTH);
    expect(s.rules).toEqual([
      { id: 'b', categoryId: 'dining', merchantRegex: '^cafe', amountEquals: -5, renameMerchant: 'Cafe' },
      { id: 'c', categoryId: 'rent', descriptionContains: 'landlord' },
    ]);
  });

  it('keeps edit flags only when they are set', () => {
    const base = migrate(v1, MONTH);
    const [a, b] = base.transactions;
    const s = migrate({
      ...base,
      transactions: [{ ...a, categoryEdited: true, merchantEdited: false }, { ...b, categoryEdited: 'yes' }],
    } as never, MONTH);
    expect(s.transactions[0]).toMatchObject({ categoryEdited: true });
    expect(s.transactions[0]).not.toHaveProperty('merchantEdited');
    expect(s.transactions[1]).not.toHaveProperty('categoryEdited');
  });

  it('does not mutate its input', () => {
    const copy = JSON.parse(JSON.stringify(v1));
    migrate(v1, MONTH);
    expect(v1).toEqual(copy);
  });
});
