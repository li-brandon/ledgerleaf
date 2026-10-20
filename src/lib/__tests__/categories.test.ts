import { describe, expect, it } from 'vitest';
import {
  addCategory, categoryUsage, deleteCategory, findCategory, inUse, newCategoryId, updateCategory, validateCategory,
  type CategoryDraft,
} from '../categories';
import { emptyLedger } from '../migrate';
import type { Budget, LedgerState, Rule, Transaction } from '../types';

const tx = (id: string, categoryId: string, category: string): Transaction => ({
  id, date: '2026-10-01', description: id, amount: -10, category, categoryId, accountId: 'a1',
});

const draft = (over: Partial<CategoryDraft> = {}): CategoryDraft => ({
  name: 'Coffee', group: 'Lifestyle', color: '#6b4f3a', icon: '☕', excludeFromSpend: false, ...over,
});

const budget = (categoryId: string, month: string, amount: number): Budget =>
  ({ id: `${categoryId}:${month}`, categoryId, month, amount, rollover: false });

function ledger(over: Partial<LedgerState> = {}): LedgerState {
  return { ...emptyLedger('2026-10'), budgets: [], ...over };
}

const cat = (s: LedgerState, id: string) => s.categories.find((c) => c.id === id);

describe('addCategory', () => {
  it('adds a category with a slug id and tidied fields', () => {
    const s = ledger();
    const next = addCategory(s, draft({ name: ' Coffee Shops ', group: ' ', icon: '' }));
    expect(next.categories.at(-1)).toEqual({
      id: 'coffee-shops', name: 'Coffee Shops', group: 'Custom', color: '#6b4f3a', icon: '•', excludeFromSpend: false,
    });
    expect(s.categories).toHaveLength(next.categories.length - 1);
  });

  it('rejects blank and duplicate names and bad colors', () => {
    const s = ledger();
    expect(() => addCategory(s, draft({ name: '  ' }))).toThrow(/name/);
    expect(() => addCategory(s, draft({ name: 'dining' }))).toThrow(/already/);
    expect(() => addCategory(s, draft({ color: 'red' }))).toThrow(/color/);
  });

  it('never reuses an id, even after a rename', () => {
    const renamed = updateCategory(ledger(), 'dining', draft({ name: 'Restaurants' }));
    const next = addCategory(renamed, draft({ name: 'Dining' }));
    expect(next.categories.at(-1)?.id).toBe('dining-2');
    expect(findCategory(next.categories, 'Dining')?.id).toBe('dining-2');
    expect(findCategory(next.categories, 'dining')?.name).toBe('Restaurants');
    expect(newCategoryId(next.categories, 'Dining')).toBe('dining-3');
  });
});

describe('updateCategory', () => {
  it('renames a category and the transactions in it', () => {
    const s = ledger({ transactions: [tx('a', 'dining', 'Dining'), tx('b', 'rent', 'Rent')] });
    const next = updateCategory(s, 'dining', draft({ name: 'Eating out', excludeFromSpend: true }));
    expect(cat(next, 'dining')).toMatchObject({ name: 'Eating out', excludeFromSpend: true, icon: '☕' });
    expect(next.transactions.map((t) => t.category)).toEqual(['Eating out', 'Rent']);
    expect(next.transactions[1]).toBe(s.transactions[1]);
  });

  it('allows keeping its own name but not taking another', () => {
    const s = ledger();
    const dining = cat(s, 'dining')!;
    expect(updateCategory(s, 'dining', { ...dining })).toBe(s);
    expect(validateCategory({ ...dining, name: 'DINING' }, s.categories, 'dining')).toBeUndefined();
    expect(() => updateCategory(s, 'dining', { ...dining, name: 'Rent' })).toThrow(/already/);
  });

  it('ignores an unknown id', () => {
    const s = ledger();
    expect(updateCategory(s, 'nope', draft())).toBe(s);
  });
});

describe('deleteCategory', () => {
  const rule: Rule = { id: 'r1', categoryId: 'dining', merchant: 'Cafe' };

  it('deletes a category nothing uses', () => {
    const s = ledger();
    expect(inUse(categoryUsage(s, 'travel'))).toBe(false);
    const next = deleteCategory(s, 'travel');
    expect(cat(next, 'travel')).toBeUndefined();
    expect(next.categories).toHaveLength(s.categories.length - 1);
  });

  it('refuses to delete a category in use without somewhere to move it', () => {
    const withTx = ledger({ transactions: [tx('a', 'dining', 'Dining')] });
    const withBudget = ledger({ budgets: [budget('dining', '2026-10', 300)] });
    const withRule = ledger({ rules: [rule] });
    for (const s of [withTx, withBudget, withRule]) {
      expect(inUse(categoryUsage(s, 'dining'))).toBe(true);
      expect(() => deleteCategory(s, 'dining')).toThrow(/in use/);
    }
    expect(() => deleteCategory(withTx, 'dining', 'dining')).toThrow(/another/);
    expect(() => deleteCategory(withTx, 'dining', 'ghost')).toThrow(/another/);
  });

  it('moves transactions, rules and budgets to the chosen category', () => {
    const s = ledger({
      transactions: [tx('a', 'dining', 'Dining'), tx('b', 'rent', 'Rent'), { ...tx('c', 'dining', 'Dining'), categoryEdited: true }],
      rules: [rule, { id: 'r2', categoryId: 'rent', amountEquals: -1650 }],
      budgets: [budget('dining', '2026-09', 250), budget('dining', '2026-10', 300), budget('rent', '2026-10', 1650)],
    });
    expect(categoryUsage(s, 'dining')).toEqual({ transactions: 2, budgets: 2, rules: 1 });
    const next = deleteCategory(s, 'dining', 'entertainment');
    expect(cat(next, 'dining')).toBeUndefined();
    expect(next.transactions.map((t) => [t.categoryId, t.category])).toEqual([
      ['entertainment', 'Entertainment'], ['rent', 'Rent'], ['entertainment', 'Entertainment'],
    ]);
    expect(next.transactions[2].categoryEdited).toBe(true);
    expect(next.rules.map((r) => r.categoryId)).toEqual(['entertainment', 'rent']);
    expect(next.budgets).toEqual([
      budget('entertainment', '2026-09', 250), budget('entertainment', '2026-10', 300), budget('rent', '2026-10', 1650),
    ]);
    expect(categoryUsage(next, 'dining')).toEqual({ transactions: 0, budgets: 0, rules: 0 });
  });

  it('keeps the target\'s own budget instead of overwriting it', () => {
    const s = ledger({ budgets: [budget('dining', '2026-10', 300), budget('groceries', '2026-01', 500)] });
    const next = deleteCategory(s, 'dining', 'groceries');
    expect(next.budgets).toEqual([budget('groceries', '2026-01', 500)]);
  });

  it('keeps at least one category', () => {
    const s = ledger({ categories: [ledger().categories[0]] });
    expect(() => deleteCategory(s, s.categories[0].id)).toThrow(/at least one/);
  });
});
