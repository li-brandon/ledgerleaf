import { describe, expect, it } from 'vitest';
import {
  addMonths, budgetAt, budgetMonthOf, budgetPeriod, currentBudgetMonth, isMonthKey, monthBudget, monthElapsed, monthTotals,
  rolloverMonth, setMonthBudget, spendByMonth,
} from '../budget';
import { defaultCategories } from '../categories';
import type { Budget, Transaction } from '../types';

const rec = (month: string, amount: number, rollover = false, categoryId = 'dining'): Budget =>
  ({ id: `${categoryId}:${month}`, categoryId, month, amount, rollover });

const spentBy = (map: Record<string, number>) => (m: string) => map[m] ?? 0;

let n = 0;
const tx = (date: string, amount: number, category: string, categoryId = category.toLowerCase()): Transaction => ({
  id: String(n++), date, description: category, amount, category, categoryId, accountId: 'a',
});

describe('month keys', () => {
  it('adds months across years', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', 0)).toBe('2026-10');
  });

  it('validates YYYY-MM', () => {
    expect(isMonthKey('2026-10')).toBe(true);
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('oct')).toBe(false);
    expect(isMonthKey(undefined)).toBe(false);
  });
});

describe('rolloverMonth', () => {
  it('carries unspent money into the next month', () => {
    const f = rolloverMonth([rec('2026-08', 200, true)], spentBy({ '2026-08': 150 }), '2026-09');
    expect(f).toEqual({ budgeted: 200, rollover: true, carry: 50, available: 250, spent: 0, remaining: 250 });
  });

  it('carries overspending as a negative amount', () => {
    const f = rolloverMonth([rec('2026-08', 200, true)], spentBy({ '2026-08': 260, '2026-09': 100 }), '2026-09');
    expect(f).toMatchObject({ carry: -60, available: 140, spent: 100, remaining: 40 });
  });

  it('can leave a month with less than nothing available', () => {
    const f = rolloverMonth([rec('2026-08', 100, true)], spentBy({ '2026-08': 350 }), '2026-09');
    expect(f).toMatchObject({ carry: -250, available: -150, remaining: -150 });
  });

  it('compounds over several months, positive and negative', () => {
    const spent = spentBy({ '2026-07': 50, '2026-08': 300, '2026-09': 120 });
    // Jul: 100 avail, 50 left → Aug: 200 avail, -100 → Sep: 0 avail, -120 → Oct: -20
    expect(rolloverMonth([rec('2026-07', 100, true)], spent, '2026-08')).toMatchObject({ carry: 50, available: 150 });
    expect(rolloverMonth([rec('2026-07', 100, true)], spent, '2026-09')).toMatchObject({ carry: -150, available: -50 });
    expect(rolloverMonth([rec('2026-07', 100, true)], spent, '2026-10')).toMatchObject({ carry: -170, available: -70 });
  });

  it('does not carry when rollover is off, and restarts after it is turned off', () => {
    const spent = spentBy({ '2026-08': 20, '2026-09': 10 });
    expect(rolloverMonth([rec('2026-08', 100)], spent, '2026-09')).toMatchObject({ carry: 0, available: 100 });
    const chain = [rec('2026-08', 100, true), rec('2026-09', 100, false)];
    expect(rolloverMonth(chain, spent, '2026-09')).toMatchObject({ carry: 80, available: 180, rollover: false });
    expect(rolloverMonth(chain, spent, '2026-10')).toMatchObject({ carry: 0, available: 100 });
  });

  it('uses each month’s own amount along the chain', () => {
    const chain = [rec('2026-08', 100, true), rec('2026-09', 300, true)];
    const f = rolloverMonth(chain, spentBy({ '2026-08': 40, '2026-09': 310 }), '2026-10');
    // Aug leftover 60 → Sep 360 available, 50 left → Oct 300 + 50
    expect(f).toMatchObject({ budgeted: 300, carry: 50, available: 350 });
  });

  it('is empty before the first record', () => {
    expect(rolloverMonth([rec('2026-10', 100, true)], spentBy({ '2026-09': 40 }), '2026-09'))
      .toEqual({ budgeted: 0, rollover: false, carry: 0, available: 0, spent: 40, remaining: -40 });
  });

  it('rounds to cents', () => {
    const f = rolloverMonth([rec('2026-08', 10.1, true)], spentBy({ '2026-08': 0.2 }), '2026-09');
    expect(f.carry).toBe(9.9);
    expect(f.available).toBe(20);
  });
});

describe('setMonthBudget', () => {
  it('copies forward: a new month uses the previous month’s amount and rollover', () => {
    const budgets = setMonthBudget([], 'dining', '2026-10', { amount: 120, rollover: true }, '2026-10');
    expect(budgetAt(budgets, 'dining', '2026-12')).toMatchObject({ amount: 120, rollover: true });
  });

  it('keeps the other field when only one changes', () => {
    const budgets = setMonthBudget([rec('2026-08', 100, true)], 'dining', '2026-10', { amount: 150 }, '2026-10');
    expect(budgets).toContainEqual(rec('2026-10', 150, true));
    const toggled = setMonthBudget(budgets, 'dining', '2026-10', { rollover: false }, '2026-10');
    expect(toggled).toContainEqual(rec('2026-10', 150, false));
    expect(toggled).toHaveLength(2);
  });

  it('editing a past month leaves the months after it as they were', () => {
    const start = [rec('2026-07', 100, true)];
    const budgets = setMonthBudget(start, 'dining', '2026-08', { amount: 40 }, '2026-10');
    expect(budgetAt(budgets, 'dining', '2026-08')).toMatchObject({ amount: 40, rollover: true });
    expect(budgetAt(budgets, 'dining', '2026-09')).toMatchObject({ amount: 100, rollover: true });
    expect(budgetAt(budgets, 'dining', '2026-11')).toMatchObject({ amount: 100 });
  });

  it('pins a past month to no budget when there was none', () => {
    const budgets = setMonthBudget([], 'dining', '2026-09', { amount: 50 }, '2026-10');
    expect(budgetAt(budgets, 'dining', '2026-10')).toMatchObject({ amount: 0, rollover: false });
  });

  it('does not overwrite a following month that has its own record', () => {
    const start = [rec('2026-08', 100), rec('2026-09', 70)];
    const budgets = setMonthBudget(start, 'dining', '2026-08', { amount: 90 }, '2026-10');
    expect(budgets).toEqual([rec('2026-09', 70), rec('2026-08', 90)]);
  });

  it('editing the current or a future month changes the months after it', () => {
    const budgets = setMonthBudget([rec('2026-08', 100)], 'dining', '2026-10', { amount: 80 }, '2026-10');
    expect(budgets).toHaveLength(2);
    expect(budgetAt(budgets, 'dining', '2027-03')?.amount).toBe(80);
  });
});

describe('monthElapsed', () => {
  it('is the share of days passed in the current month, 1 for past and 0 for future months', () => {
    const today = new Date(2026, 9, 10); // Oct 10, 31 days
    expect(monthElapsed('2026-10', today)).toBeCloseTo(10 / 31);
    expect(monthElapsed('2026-09', today)).toBe(1);
    expect(monthElapsed('2026-11', today)).toBe(0);
  });
});

describe('monthBudget', () => {
  const categories = defaultCategories();
  const budgets = [rec('2026-09', 300, true), rec('2026-09', 1500, false, 'rent'), rec('2026-09', 200, false, 'income')];
  const transactions = [
    tx('2026-09-05', -250, 'Dining'),
    tx('2026-10-03', -60, 'Dining'),
    tx('2026-10-04', 10, 'Dining'), // refund
    tx('2026-10-01', -1500, 'Rent'),
    tx('2026-10-08', -45, 'Shopping'),
    tx('2026-10-01', 4000, 'Income'),
  ];
  const today = new Date(2026, 9, 15);
  const rows = monthBudget({ budgets, categories, transactions }, '2026-10', today);
  const by = Object.fromEntries(rows.map((r) => [r.categoryId, r]));

  it('applies rollover, spend and remaining per category', () => {
    expect(by.dining).toMatchObject({
      category: 'Dining', budgeted: 300, carry: 50, available: 350, spent: 50, remaining: 300, status: 'ok',
    });
    expect(by.rent).toMatchObject({ available: 1500, spent: 1500, remaining: 0, status: 'near' });
  });

  it('shows spending without a budget as over', () => {
    expect(by.shopping).toMatchObject({ budgeted: 0, available: 0, spent: 45, remaining: -45, status: 'over', ratio: Infinity });
  });

  it('hides categories excluded from spending', () => {
    expect(by.income).toBeUndefined();
    const hidden = categories.map((c) => (c.id === 'dining' ? { ...c, excludeFromSpend: true } : c));
    expect(monthBudget({ budgets, categories: hidden, transactions }, '2026-10', today).map((r) => r.categoryId))
      .not.toContain('dining');
  });

  it('works out what should be spent by today', () => {
    expect(by.dining.expected).toBeCloseTo(350 * 15 / 31, 2);
    const past = monthBudget({ budgets, categories, transactions }, '2026-09', today);
    expect(past.find((r) => r.categoryId === 'dining')?.expected).toBe(300);
  });

  it('marks a category over when its overspend rolled in', () => {
    const over = monthBudget({ budgets: [rec('2026-09', 100, true)], categories, transactions }, '2026-10', today);
    // Sep: 100 − 250 = −150 carried; Oct: −50 available, 50 spent.
    expect(over.find((r) => r.categoryId === 'dining')).toMatchObject({ carry: -150, available: -50, remaining: -100, status: 'over', expected: 0 });
  });

  it('totals the rows', () => {
    expect(monthTotals(rows)).toEqual({
      budgeted: 1800, carry: 50, available: 1850, spent: 1595, remaining: 255,
      expected: Math.round((by.dining.expected + by.rent.expected) * 100) / 100,
    });
  });
});

describe('budget months with a custom start day', () => {
  it('assigns dates before the start day to the previous budget month', () => {
    expect(budgetMonthOf('2026-11-03', 15)).toBe('2026-10');
    expect(budgetMonthOf('2026-11-15', 15)).toBe('2026-11');
    expect(budgetMonthOf('2026-01-14', 15)).toBe('2025-12');
    expect(budgetMonthOf('2026-11-03')).toBe('2026-11');
  });

  it('finds the current budget month', () => {
    expect(currentBudgetMonth(15, new Date(2026, 9, 20))).toBe('2026-10');
    expect(currentBudgetMonth(25, new Date(2026, 9, 20))).toBe('2026-09');
    expect(currentBudgetMonth(1, new Date(2026, 9, 20))).toBe('2026-10');
  });

  it('spans start day to the day before the next start', () => {
    expect(budgetPeriod('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(budgetPeriod('2026-10', 15)).toEqual({ from: '2026-10-15', to: '2026-11-14' });
    expect(budgetPeriod('2026-12', 28)).toEqual({ from: '2026-12-28', to: '2027-01-27' });
    expect(budgetPeriod('2026-01', 28)).toEqual({ from: '2026-01-28', to: '2026-02-27' });
  });

  it('measures elapsed share within the shifted period', () => {
    // Oct 15 – Nov 14 is 31 days; Oct 20 is day 6.
    expect(monthElapsed('2026-10', new Date(2026, 9, 20), 15)).toBeCloseTo(6 / 31);
    expect(monthElapsed('2026-09', new Date(2026, 9, 20), 15)).toBe(1);
    expect(monthElapsed('2026-11', new Date(2026, 9, 20), 15)).toBe(0);
    // A start day of 1 matches calendar months.
    expect(monthElapsed('2026-10', new Date(2026, 9, 20))).toBeCloseTo(20 / 31);
    expect(monthElapsed('2026-10', new Date(2026, 9, 20), 1)).toBeCloseTo(20 / 31);
  });

  it('counts spending in the budget month its date falls in', () => {
    const txns = [tx('2026-10-14', -40, 'Dining'), tx('2026-10-15', -25, 'Dining'), tx('2026-11-14', -10, 'Dining'), tx('2026-11-15', -5, 'Dining')];
    const state = { budgets: [rec('2026-09', 100)], categories: defaultCategories(), transactions: txns };
    const today = new Date(2026, 10, 1);
    expect(monthBudget(state, '2026-10', today, 15).find((r) => r.categoryId === 'dining')?.spent).toBe(35);
    expect(monthBudget(state, '2026-09', today, 15).find((r) => r.categoryId === 'dining')?.spent).toBe(40);
    expect(monthBudget(state, '2026-10', today).find((r) => r.categoryId === 'dining')?.spent).toBe(65);
    expect(spendByMonth(txns, undefined, 15).get('2026-11')?.get('dining')).toBe(5);
  });
});

describe('rollover edge cases', () => {
  it('keeps carrying through months with no record of their own', () => {
    const f = rolloverMonth([rec('2026-07', 100, true)], spentBy({ '2026-07': 50, '2026-08': 120, '2026-09': 0 }), '2026-10');
    // Jul +50, Aug 150-120 = +30, Sep 130 unspent: October starts with 130 carried.
    expect(f).toMatchObject({ budgeted: 100, carry: 130, available: 230 });
  });

  it('carries across a year boundary', () => {
    const f = rolloverMonth([rec('2025-12', 80, true)], spentBy({ '2025-12': 30 }), '2026-01');
    expect(f).toMatchObject({ carry: 50, available: 130 });
  });

  it('ignores records after the month asked for', () => {
    const f = rolloverMonth([rec('2026-09', 100, true), rec('2026-11', 999, true)], spentBy({}), '2026-10');
    expect(f).toMatchObject({ budgeted: 100, carry: 100, available: 200 });
  });

  it('nets refunds within a month but never carries negative spending', () => {
    const spend = spendByMonth([tx('2026-09-02', -40, 'Dining'), tx('2026-09-20', 70, 'Dining'), tx('2026-10-01', -10, 'Dining')]);
    expect(spend.get('2026-09')?.get('dining')).toBe(0);
    const f = rolloverMonth([rec('2026-09', 100, true)], (m) => spend.get(m)?.get('dining') ?? 0, '2026-10');
    expect(f).toMatchObject({ carry: 100, available: 200, spent: 10, remaining: 190 });
  });

  it('follows a custom start day when carrying over', () => {
    const txns = [tx('2026-09-14', -30, 'Dining'), tx('2026-09-15', -500, 'Dining')];
    const rows = monthBudget({ budgets: [rec('2026-08', 100, true)], categories: defaultCategories(), transactions: txns },
      '2026-09', new Date(2026, 8, 20), 15);
    // With months starting on the 15th, the 14th belongs to August's budget month.
    expect(rows.find((r) => r.categoryId === 'dining')).toMatchObject({ carry: 70, available: 170, spent: 500, status: 'over' });
  });
});
