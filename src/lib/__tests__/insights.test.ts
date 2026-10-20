import { describe, expect, it } from 'vitest';
import { accountBalance, monthRange, monthlySpend, netBalance, rankCategories, topMerchants } from '../insights';
import type { Transaction } from '../types';

let n = 0;
const tx = (date: string, amount: number, category: string, description = category, accountId = 'a'): Transaction => ({
  id: String(n++), date, description, amount, category, accountId,
});

const txns = [
  tx('2026-08-03', -50, 'Dining', 'Nori House'),
  tx('2026-10-02', -20, 'Dining', 'Nori House'),
  tx('2026-10-05', -200, 'Groceries', 'Harvest Co-op'),
  tx('2026-10-06', -10, 'Dining', 'Slice & Co', 'b'),
  tx('2026-10-01', 1000, 'Income', 'Payroll'),
  tx('2026-10-15', -300, 'Transfer', 'To savings'),
];

describe('monthRange', () => {
  it('crosses year boundaries', () => expect(monthRange('2026-02', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']));
});

describe('monthlySpend', () => {
  const rows = monthlySpend(txns, monthRange('2026-10', 3));
  it('fills empty months and excludes non-spend', () => {
    expect(rows.map((r) => r.total)).toEqual([50, 0, 230]);
    expect(rows[2].byCategory).toEqual({ Dining: 30, Groceries: 200 });
  });
  it('ranks categories', () => expect(rankCategories(rows)).toEqual(['Groceries', 'Dining']));
});

describe('topMerchants', () => {
  it('aggregates and limits', () => {
    expect(topMerchants(txns, 2)).toEqual([
      { name: 'Harvest Co-op', total: 200, count: 1 },
      { name: 'Nori House', total: 70, count: 2 },
    ]);
  });
  it('filters by months', () => expect(topMerchants(txns, 5, ['2026-08'])).toEqual([{ name: 'Nori House', total: 50, count: 1 }]));
});

describe('balances', () => {
  it('uses explicit balance when present, else derives', () => {
    expect(accountBalance({ id: 'a', name: 'A', type: 'checking', balance: 5 }, txns)).toBe(5);
    expect(accountBalance({ id: 'b', name: 'B', type: 'credit' }, txns)).toBe(-10);
    expect(netBalance([{ id: 'a', name: 'A', type: 'checking', balance: 5 }, { id: 'b', name: 'B', type: 'credit' }], txns)).toBe(-5);
  });
});
