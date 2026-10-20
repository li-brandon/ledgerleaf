import { describe, expect, it } from 'vitest';
import {
  budgetProgress, budgetTotals, budgetsForMonth, currentMonth, isSpend, spendByCategory, spendExclusions, upsertBudget,
} from '../budget';
import { defaultCategories } from '../categories';
import type { Transaction } from '../types';

let n = 0;
const tx = (date: string, amount: number, category: string): Transaction => ({
  id: String(n++), date, description: category, amount, category, accountId: 'a',
});

const txns = [
  tx('2026-10-02', -80, 'Groceries'),
  tx('2026-10-09', -40.5, 'Groceries'),
  tx('2026-10-10', 20.5, 'Groceries'), // refund
  tx('2026-10-03', -95, 'Dining'),
  tx('2026-10-04', -30, 'Shopping'),
  tx('2026-10-01', 3000, 'Income'),
  tx('2026-10-15', -500, 'Transfer'),
  tx('2026-09-30', -999, 'Dining'),
];

describe('spendByCategory', () => {
  it('nets refunds, ignores income/transfers and other months', () => {
    expect(spendByCategory(txns, '2026-10')).toEqual({ Groceries: 100, Dining: 95, Shopping: 30 });
  });
});

describe('budgetProgress', () => {
  const lines = budgetProgress({ Groceries: 400, Dining: 100, Health: 50 }, txns, '2026-10');
  const by = Object.fromEntries(lines.map((l) => [l.category, l]));

  it('computes remaining and status', () => {
    expect(by.Groceries).toMatchObject({ spent: 100, remaining: 300, status: 'ok' });
    expect(by.Dining).toMatchObject({ spent: 95, status: 'near' });
    expect(by.Health).toMatchObject({ spent: 0, ratio: 0, status: 'ok' });
  });

  it('includes unbudgeted spend as over', () => {
    expect(by.Shopping).toMatchObject({ budget: 0, spent: 30, status: 'over', ratio: Infinity });
  });

  it('totals', () => {
    expect(budgetTotals(lines)).toEqual({ budgeted: 550, spent: 225 });
  });
});

describe('currentMonth', () => {
  it('formats YYYY-MM', () => expect(currentMonth(new Date(2026, 0, 5))).toBe('2026-01'));
});

describe('budgetsForMonth / upsertBudget', () => {
  const cats = [
    { id: 'dining', name: 'Dining', group: 'g', color: '', icon: '', excludeFromSpend: false },
    { id: 'rent', name: 'Rent', group: 'g', color: '', icon: '', excludeFromSpend: false },
  ];
  const b = (categoryId: string, month: string, amount: number) =>
    ({ id: `${categoryId}:${month}`, categoryId, month, amount, rollover: false });

  it('uses the latest record on or before the month, keyed by name', () => {
    const budgets = [b('dining', '2026-08', 100), b('dining', '2026-10', 150), b('rent', '2026-11', 1700)];
    expect(budgetsForMonth(budgets, cats, '2026-07')).toEqual({});
    expect(budgetsForMonth(budgets, cats, '2026-09')).toEqual({ Dining: 100 });
    expect(budgetsForMonth(budgets, cats, '2026-12')).toEqual({ Dining: 150, Rent: 1700 });
  });

  it('replaces the record for the month and carries rollover forward', () => {
    const start = [{ ...b('dining', '2026-08', 100), rollover: true }];
    const next = upsertBudget(upsertBudget(start, 'dining', '2026-10', 120), 'dining', '2026-10', 130);
    expect(next).toEqual([start[0], { ...b('dining', '2026-10', 130), rollover: true }]);
  });
});

describe('exclude from spending', () => {
  const categories = defaultCategories().map((c) => (c.id === 'shopping' ? { ...c, excludeFromSpend: true } : c));
  const excluded = spendExclusions(categories);

  it('collects the ids of excluded categories', () => {
    expect([...excluded].sort()).toEqual(['income', 'shopping', 'transfer']);
  });

  it('leaves excluded categories out of spend and budget progress', () => {
    expect(spendByCategory(txns, '2026-10', excluded)).toEqual({ Groceries: 100, Dining: 95 });
    const lines = budgetProgress({ Groceries: 400 }, txns, '2026-10', excluded);
    expect(lines.map((l) => l.category)).toEqual(['Groceries', 'Dining']);
    expect(budgetTotals(lines).spent).toBe(195);
  });

  it('counts a category again once the flag is cleared, by id even after a rename', () => {
    const renamed = { ...tx('2026-10-05', -12, 'Income'), category: 'Side gig', categoryId: 'side-gig' };
    expect(isSpend(renamed, spendExclusions(categories))).toBe(true);
    expect(isSpend({ ...renamed, categoryId: 'income' }, excluded)).toBe(false);
    expect(spendByCategory(txns, '2026-10', new Set())).toMatchObject({ Transfer: 500, Shopping: 30 });
  });

  it('drops budgets of excluded categories', () => {
    const budgets = [
      { id: 'shopping:2026-10', categoryId: 'shopping', month: '2026-10', amount: 250, rollover: false },
      { id: 'dining:2026-10', categoryId: 'dining', month: '2026-10', amount: 300, rollover: false },
    ];
    expect(budgetsForMonth(budgets, categories, '2026-10')).toEqual({ Dining: 300 });
  });
});
