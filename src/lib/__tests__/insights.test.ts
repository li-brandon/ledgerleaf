import { describe, expect, it } from 'vitest';
import {
  accountBalance, categoryShares, categoryTrend, monthOverMonth, monthRange, monthlySpend, monthsSpan, netBalance,
  pctChange, rankCategories, spendHref, topMerchants,
} from '../insights';
import { parseRoute } from '../routes';
import { matcher, parseFilters } from '../txFilters';
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

describe('exclude from spending', () => {
  const excluded = new Set(['income', 'transfer', 'dining']);

  it('leaves excluded categories out of monthly spend and top merchants', () => {
    const rows = monthlySpend(txns, monthRange('2026-10', 1), excluded);
    expect(rows[0]).toEqual({ month: '2026-10', total: 200, byCategory: { Groceries: 200 } });
    expect(topMerchants(txns, 5, undefined, excluded).map((m) => m.name)).toEqual(['Harvest Co-op']);
  });

  it('counts Transfer once it is no longer excluded', () => {
    expect(monthlySpend(txns, ['2026-10'], new Set(['income']))[0].byCategory).toMatchObject({ Transfer: 300 });
  });

  it('groups top merchants by their (renamed) merchant', () => {
    const renamed = [tx('2026-10-02', -20, 'Dining', 'SQ *NORI 1'), tx('2026-10-03', -5, 'Dining', 'SQ *NORI 2')]
      .map((t) => ({ ...t, merchant: 'Nori House' }));
    expect(topMerchants(renamed)).toEqual([{ name: 'Nori House', total: 25, count: 2 }]);
  });
});

describe('categoryShares', () => {
  it('sums categories across months with their share of the period', () => {
    const shares = categoryShares(monthlySpend(txns, monthRange('2026-10', 3)));
    expect(shares.map((s) => [s.category, s.total])).toEqual([['Groceries', 200], ['Dining', 80]]);
    expect(shares[0].share).toBeCloseTo(200 / 280);
    expect(shares.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1);
  });
  it('leaves out transfers and income', () => {
    expect(categoryShares(monthlySpend(txns, ['2026-10'])).map((s) => s.category)).not.toContain('Transfer');
  });
  it('is empty with no spending', () => expect(categoryShares(monthlySpend(txns, ['2026-09']))).toEqual([]));
});

describe('categoryTrend', () => {
  const rows = monthlySpend(txns, monthRange('2026-10', 3));
  it('follows one category, zero in months without it', () =>
    expect(categoryTrend(rows, 'Groceries').map((p) => p.value)).toEqual([0, 0, 200]));
  it('follows total spend without a category', () =>
    expect(categoryTrend(rows).map((p) => p.value)).toEqual([50, 0, 230]));
});

describe('pctChange', () => {
  it('is relative to the base', () => {
    expect(pctChange(150, 100)).toBe(0.5);
    expect(pctChange(50, 100)).toBe(-0.5);
  });
  it('is null without a base', () => expect(pctChange(10, 0)).toBeNull());
});

describe('monthOverMonth', () => {
  const data = [
    tx('2026-06-04', -90, 'Dining'), // 4 months back: outside the average
    tx('2026-07-10', -30, 'Groceries'),
    tx('2026-08-04', -60, 'Dining'),
    tx('2026-09-04', -30, 'Dining'),
    tx('2026-09-12', -100, 'Groceries'),
    tx('2026-10-04', -45, 'Dining'),
    tx('2026-10-08', -200, 'Groceries'),
    tx('2026-10-08', 40, 'Groceries'), // refunds are not spend
    tx('2026-10-20', -12, 'Shopping'),
    tx('2026-10-01', 3000, 'Income'),
    tx('2026-10-15', -500, 'Transfer'),
  ];
  const { rows, total } = monthOverMonth(data, '2026-10');

  it('compares this month with last month and the 3 months before', () => {
    const dining = rows.find((r) => r.category === 'Dining')!;
    expect(dining).toMatchObject({ current: 45, previous: 30, average: 30 });
    expect(dining.vsPrevious).toBeCloseTo(0.5);
    expect(dining.vsAverage).toBeCloseTo(0.5);
    const groceries = rows.find((r) => r.category === 'Groceries')!;
    expect(groceries).toMatchObject({ current: 200, previous: 100, average: 43.33 });
    expect(groceries.vsPrevious).toBe(1);
  });

  it('orders by this month and has no % for a new category', () => {
    expect(rows.map((r) => r.category)).toEqual(['Groceries', 'Dining', 'Shopping']);
    expect(rows[2]).toMatchObject({ current: 12, previous: 0, vsPrevious: null, vsAverage: null });
  });

  it('totals spend only, without transfers or income', () => {
    expect(total).toMatchObject({ category: 'Total', current: 257, previous: 130, average: 73.33 });
    expect(rows.map((r) => r.category)).not.toContain('Transfer');
    expect(rows.map((r) => r.category)).not.toContain('Income');
  });

  it('respects custom exclusions', () => {
    const r = monthOverMonth(data, '2026-10', new Set(['income', 'transfer', 'groceries']));
    expect(r.rows.map((x) => x.category)).toEqual(['Dining', 'Shopping']);
    expect(r.total.current).toBe(57);
  });

  it('crosses a year boundary', () => {
    const r = monthOverMonth([tx('2025-12-03', -10, 'Dining'), tx('2026-01-03', -20, 'Dining')], '2026-01');
    expect(r.total).toMatchObject({ current: 20, previous: 10 });
  });
});

describe('spendHref', () => {
  it('spans whole months', () => {
    expect(monthsSpan(['2026-02'])).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthsSpan(monthRange('2026-01', 3))).toEqual({ from: '2025-11-01', to: '2026-01-31' });
  });

  it('opens Transactions filtered to the slice', () => {
    const href = spendHref(['2026-10'], { category: 'Dining' });
    const route = parseRoute(href);
    expect(route.id).toBe('transactions');
    const match = matcher(parseFilters(route.params));
    expect(txns.filter(match).map((t) => t.description)).toEqual(['Nori House', 'Slice & Co']);
  });

  it('opens several categories at once, adding up to their combined spend', () => {
    const href = spendHref(['2026-10'], { category: ['Dining', 'Groceries'] });
    expect(href).toContain('category=Dining%2CGroceries');
    const shown = txns.filter(matcher(parseFilters(parseRoute(href).params)));
    const rows = monthlySpend(txns, ['2026-10']);
    expect(-shown.reduce((s, t) => s + t.amount, 0)).toBe(rows[0].byCategory.Dining + rows[0].byCategory.Groceries);
    // Transfers and income are never pulled in.
    expect(shown.map((t) => t.category)).not.toContain('Transfer');
  });

  it('filters by merchant', () => {
    const match = matcher(parseFilters(parseRoute(spendHref(monthRange('2026-10', 3), { merchant: 'Nori House' })).params));
    expect(txns.filter(match)).toHaveLength(2);
  });
});
