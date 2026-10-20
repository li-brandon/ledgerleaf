import { describe, expect, it } from 'vitest';
import { budgetProgress, budgetTotals, currentMonth, spendByCategory } from '../budget';
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
