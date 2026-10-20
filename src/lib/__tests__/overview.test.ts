import { describe, expect, it } from 'vitest';
import { spendExclusions } from '../budget';
import { defaultCategories } from '../categories';
import {
  cashFlow, cumulativeDailySpend, daysInMonth, incomeCategories, netWorthTrend, reviewQueue, spendPace,
  trendChange, upcomingRecurring,
} from '../overview';
import type { Account, BalanceSnapshot, Category, Transaction } from '../types';

let n = 0;
const tx = (date: string, amount: number, category: string, extra: Partial<Transaction> = {}): Transaction => ({
  id: String(n++), date, description: category, amount, category, accountId: 'a', ...extra,
});

const today = new Date(2026, 9, 5); // 2026-10-05

describe('daysInMonth', () => {
  it('handles leap years', () => {
    expect(daysInMonth('2028-02')).toBe(29);
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2026-10')).toBe(31);
  });
});

describe('cumulativeDailySpend', () => {
  const txns = [
    tx('2026-10-01', -10, 'Dining'),
    tx('2026-10-03', -20, 'Groceries'),
    tx('2026-10-03', 5, 'Dining'), // refund
    tx('2026-10-04', -300, 'Transfer'),
    tx('2026-10-04', 1000, 'Income'),
    tx('2026-10-09', -99, 'Dining'), // after today
  ];
  it('runs through today for the current month, leaving out non-spend', () => {
    expect(cumulativeDailySpend(txns, '2026-10', undefined, today)).toEqual([10, 10, 25, 25, 25]);
  });
  it('covers every day of a past month and nothing of a future one', () => {
    expect(cumulativeDailySpend([tx('2026-09-30', -7, 'Dining')], '2026-09', undefined, today)).toHaveLength(30);
    expect(cumulativeDailySpend([tx('2026-09-30', -7, 'Dining')], '2026-09', undefined, today).at(-1)).toBe(7);
    expect(cumulativeDailySpend(txns, '2026-11', undefined, today)).toEqual([]);
  });
  it('never dips below zero on a net refund', () => {
    expect(cumulativeDailySpend([tx('2026-10-01', 40, 'Dining'), tx('2026-10-02', -10, 'Dining')], '2026-10', undefined, today))
      .toEqual([0, 0, 0, 0, 0]);
  });
  it('respects custom exclusions', () => {
    const cats: Category[] = defaultCategories().map((c) => (c.id === 'dining' ? { ...c, excludeFromSpend: true } : c));
    expect(cumulativeDailySpend(txns, '2026-10', spendExclusions(cats), today).at(-1)).toBe(20);
  });
});

describe('spendPace', () => {
  it('compares to last month by the same day', () => {
    const txns = [tx('2026-09-02', -40, 'Dining'), tx('2026-09-20', -60, 'Dining'), tx('2026-10-02', -15, 'Dining')];
    const p = spendPace(txns, '2026-10', undefined, today);
    expect(p.current).toHaveLength(5);
    expect(p.previous).toHaveLength(30);
    expect(p.spent).toBe(15);
    expect(p.previousToDate).toBe(40);
    expect(p.previous.at(-1)).toBe(100);
  });
  it('clamps to the end of a shorter previous month', () => {
    const p = spendPace([tx('2026-02-27', -30, 'Dining')], '2026-03', undefined, new Date(2026, 2, 31));
    expect(p.previousToDate).toBe(30);
  });
  it('is all zeros with no data', () => {
    const p = spendPace([], '2026-10', undefined, today);
    expect(p).toMatchObject({ spent: 0, previousToDate: 0 });
    expect(p.current.every((v) => v === 0)).toBe(true);
  });
});

describe('cashFlow', () => {
  const cats = defaultCategories();
  const txns = [
    tx('2026-10-01', 3000, 'Income', { categoryId: 'income' }),
    tx('2026-10-02', -1200, 'Rent'),
    tx('2026-10-03', -80, 'Dining'),
    tx('2026-10-04', 20, 'Dining'), // refund
    tx('2026-10-05', -500, 'Transfer'),
    tx('2026-10-06', 500, 'Transfer'),
    tx('2026-09-30', 3000, 'Income'),
  ];
  it('counts income and spending, leaving out transfers', () => {
    expect(cashFlow(txns, '2026-10', spendExclusions(cats), incomeCategories(cats)))
      .toEqual({ income: 3000, spending: 1260, net: 1740 });
  });
  it('defaults to the built-in categories', () => {
    expect(cashFlow(txns, '2026-10')).toEqual({ income: 3000, spending: 1260, net: 1740 });
  });
  it('treats any category in the Income group as income', () => {
    const withGig = [...cats, { id: 'side-gig', name: 'Side gig', group: 'Income', color: '#000', icon: '•', excludeFromSpend: true }];
    const flow = cashFlow([tx('2026-10-01', 250, 'Side gig', { categoryId: 'side-gig' })], '2026-10',
      spendExclusions(withGig), incomeCategories(withGig));
    expect(flow).toEqual({ income: 250, spending: 0, net: 250 });
  });
  it('is zero for an empty month', () => {
    expect(cashFlow([], '2026-10')).toEqual({ income: 0, spending: 0, net: 0 });
  });
});

describe('netWorthTrend', () => {
  const accounts: Account[] = [
    { id: 'chk', name: 'Checking', type: 'checking' },
    { id: 'card', name: 'Card', type: 'credit' },
    { id: 'old', name: 'Old', type: 'savings', hidden: true },
  ];
  const snap = (accountId: string, date: string, balance: number): BalanceSnapshot => ({ accountId, date, balance });
  const snaps = [
    snap('chk', '2026-06-30', 1000),
    snap('card', '2026-07-31', -200),
    snap('chk', '2026-07-31', 1500),
    snap('old', '2026-07-31', 99999),
    snap('chk', '2026-09-30', 1800),
    snap('chk', '2026-10-05', 1900),
  ];
  it('carries balances forward through months without a snapshot', () => {
    expect(netWorthTrend(accounts, snaps, '2026-10', 3)).toEqual([
      { month: '2026-08', total: 1300 },
      { month: '2026-09', total: 1600 },
      { month: '2026-10', total: 1700 },
    ]);
  });
  it('skips months before the first snapshot', () => {
    expect(netWorthTrend(accounts, snaps, '2026-10', 6).map((p) => p.month))
      .toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  });
  it('is empty without snapshots', () => {
    expect(netWorthTrend(accounts, [], '2026-10', 12)).toEqual([]);
  });
  it('reports the change over the range', () => {
    expect(trendChange(netWorthTrend(accounts, snaps, '2026-10', 3))).toBe(400);
    expect(trendChange([{ total: 5 }])).toBe(0);
  });
});

describe('upcomingRecurring', () => {
  const charges = [
    { name: 'Rent', amount: -1200, nextDate: '2026-11-01' },
    { name: 'Gym', amount: -40, nextDate: '2026-10-19' },
    { name: 'Stream', amount: -12, nextDate: '2026-10-20' },
    { name: 'Past', amount: -5, nextDate: '2026-10-04' },
    { name: 'Today', amount: -9, nextDate: '2026-10-05' },
  ];
  it('keeps the next 14 days, soonest first', () => {
    expect(upcomingRecurring(charges, today).map((c) => c.name)).toEqual(['Today', 'Gym']);
  });
  it('is empty until recurring detection reports charges', () => {
    expect(upcomingRecurring([], today)).toEqual([]);
  });
});

describe('reviewQueue', () => {
  it('counts unreviewed transactions and returns the newest five', () => {
    const txns = [
      tx('2026-10-01', -1, 'Dining', { id: 'a' }),
      tx('2026-10-04', -1, 'Dining', { id: 'b', reviewed: true }),
      tx('2026-10-03', -1, 'Dining', { id: 'c' }),
      tx('2026-10-03', -1, 'Dining', { id: 'd' }),
      tx('2026-09-01', -1, 'Dining', { id: 'e' }),
      tx('2026-10-05', -1, 'Dining', { id: 'f' }),
      tx('2026-08-01', -1, 'Dining', { id: 'g', reviewed: false }),
    ];
    const q = reviewQueue(txns);
    expect(q.count).toBe(6);
    expect(q.latest.map((t) => t.id)).toEqual(['f', 'c', 'd', 'a', 'e']);
  });
  it('does not reorder the input', () => {
    const txns = [tx('2026-01-01', -1, 'Dining', { id: 'x' }), tx('2026-02-01', -1, 'Dining', { id: 'y' })];
    reviewQueue(txns);
    expect(txns.map((t) => t.id)).toEqual(['x', 'y']);
  });
  it('is empty with no transactions', () => {
    expect(reviewQueue([])).toEqual({ count: 0, latest: [] });
  });
});
