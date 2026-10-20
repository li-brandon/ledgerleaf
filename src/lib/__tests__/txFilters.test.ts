import { describe, expect, it } from 'vitest';
import { parseRoute, transactionsHref } from '../routes';
import {
  EMPTY_FILTERS, activeFilterCount, applyFilters, filtersHref, filtersToParams, groupByDate, hasFilters, matcher,
  parseAmount, parseFilters, totals, type TxFilters,
} from '../txFilters';
import type { Transaction } from '../types';

const tx = (id: string, date: string, amount: number, extra: Partial<Transaction> = {}): Transaction =>
  ({ id, date, description: id, amount, category: 'Other', accountId: 'chk', ...extra });

const rows: Transaction[] = [
  tx('Rent', '2026-10-01', -1500, { category: 'Rent', categoryId: 'rent', reviewed: true }),
  tx('SQ *BLUE BOTTLE', '2026-10-03', -5.5, { category: 'Dining', merchant: 'Blue Bottle Coffee', accountId: 'card' }),
  tx('Paycheck', '2026-10-03', 2400, { category: 'Income', reviewed: true }),
  tx('AMZN Mktp', '2026-09-28', -42.1, { category: 'Shopping', notes: 'Birthday gift for Sam', accountId: 'card' }),
  tx('Refund', '2026-10-05', 42.1, { category: 'Shopping', accountId: 'card' }),
  tx('Zero', '2026-10-02', 0),
];
const f = (over: Partial<TxFilters>): TxFilters => ({ ...EMPTY_FILTERS, ...over });
const ids = (list: Transaction[]) => list.map((t) => t.id);

describe('parseFilters', () => {
  it('defaults to no filters', () => {
    expect(parseFilters({})).toEqual(EMPTY_FILTERS);
  });

  it('reads every parameter', () => {
    expect(parseFilters({
      q: 'coffee', account: 'card', category: 'Dining', from: '2026-01-01', to: '2026-03-31',
      min: '10', max: '99.5', reviewed: 'unreviewed', type: 'expense',
    })).toEqual({
      q: 'coffee', account: 'card', category: 'Dining', from: '2026-01-01', to: '2026-03-31',
      min: 10, max: 99.5, reviewed: 'unreviewed', kind: 'expense',
    });
  });

  it('ignores invalid dates, amounts and enum values', () => {
    expect(parseFilters({ from: '2026-1-1', to: 'yesterday', min: '-5', max: 'lots', reviewed: 'yes', type: 'all' }))
      .toEqual(EMPTY_FILTERS);
  });

  it('ignores parameters that only exist on Object.prototype', () => {
    expect(parseFilters(Object.fromEntries([['toString', 'x']]))).toEqual(EMPTY_FILTERS);
  });
});

describe('parseAmount', () => {
  it('accepts blank, zero and decimals', () => {
    expect(parseAmount(undefined)).toBeUndefined();
    expect(parseAmount('  ')).toBeUndefined();
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount(' 12.75 ')).toBe(12.75);
    expect(parseAmount('Infinity')).toBeUndefined();
  });
});

describe('filtersToParams and filtersHref', () => {
  it('leaves out unset filters and trims the search', () => {
    expect(filtersToParams(EMPTY_FILTERS)).toEqual({});
    expect(filtersToParams(f({ q: '  coffee ', min: 0 }))).toEqual({ q: 'coffee', min: '0' });
    expect(filtersHref(EMPTY_FILTERS)).toBe('#/transactions');
  });

  it('matches the account links used by Accounts and Overview', () => {
    expect(filtersHref(f({ account: 'demo-card' }))).toBe(transactionsHref('demo-card'));
    expect(parseFilters(parseRoute(transactionsHref('demo-card')).params)).toEqual(f({ account: 'demo-card' }));
  });

  it('round-trips through the hash', () => {
    const all = f({
      q: 'a&b #1', account: 'acct/1', category: 'Dining', from: '2026-01-01', to: '2026-12-31',
      min: 5, max: 50, reviewed: 'reviewed', kind: 'income',
    });
    const href = filtersHref(all);
    expect(href).toBe('#/transactions?q=a%26b+%231&account=acct%2F1&category=Dining&from=2026-01-01&to=2026-12-31'
      + '&min=5&max=50&reviewed=reviewed&type=income');
    expect(parseFilters(parseRoute(href).params)).toEqual(all);
  });

  it('counts active filters', () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(hasFilters(f({ q: '   ' }))).toBe(false);
    expect(activeFilterCount(f({ q: 'x', min: 0, kind: 'expense' }))).toBe(3);
  });
});

describe('matcher', () => {
  const run = (over: Partial<TxFilters>) => ids(rows.filter(matcher(f(over))));

  it('searches description, merchant and notes case-insensitively', () => {
    expect(run({ q: 'COFFEE' })).toEqual(['SQ *BLUE BOTTLE']);
    expect(run({ q: 'blue bottle' })).toEqual(['SQ *BLUE BOTTLE']);
    expect(run({ q: 'gift' })).toEqual(['AMZN Mktp']);
    expect(run({ q: '  paycheck ' })).toEqual(['Paycheck']);
    expect(run({ q: 'shopping' })).toEqual([]);
  });

  it('filters by account', () => {
    expect(run({ account: 'card' })).toEqual(['SQ *BLUE BOTTLE', 'AMZN Mktp', 'Refund']);
  });

  it('filters by category name (any case) or id', () => {
    expect(run({ category: 'shopping' })).toEqual(['AMZN Mktp', 'Refund']);
    expect(run({ category: 'rent' })).toEqual(['Rent']);
  });

  it('filters by an inclusive date range, swapping reversed bounds', () => {
    expect(run({ from: '2026-10-02', to: '2026-10-03' })).toEqual(['SQ *BLUE BOTTLE', 'Paycheck', 'Zero']);
    expect(run({ from: '2026-10-03', to: '2026-10-02' })).toEqual(['SQ *BLUE BOTTLE', 'Paycheck', 'Zero']);
    expect(run({ to: '2026-09-30' })).toEqual(['AMZN Mktp']);
    expect(run({ from: '2026-10-04' })).toEqual(['Refund']);
  });

  it('filters by an inclusive absolute amount range, swapping reversed bounds', () => {
    expect(run({ min: 42.1, max: 42.1 })).toEqual(['AMZN Mktp', 'Refund']);
    expect(run({ min: 100, max: 5 })).toEqual(['SQ *BLUE BOTTLE', 'AMZN Mktp', 'Refund']);
    expect(run({ min: 1000 })).toEqual(['Rent', 'Paycheck']);
    expect(run({ max: 0 })).toEqual(['Zero']);
  });

  it('filters by review status', () => {
    expect(run({ reviewed: 'reviewed' })).toEqual(['Rent', 'Paycheck']);
    expect(run({ reviewed: 'unreviewed' })).toEqual(['SQ *BLUE BOTTLE', 'AMZN Mktp', 'Refund', 'Zero']);
  });

  it('filters income and expenses by sign, leaving zero amounts out of both', () => {
    expect(run({ kind: 'income' })).toEqual(['Paycheck', 'Refund']);
    expect(run({ kind: 'expense' })).toEqual(['Rent', 'SQ *BLUE BOTTLE', 'AMZN Mktp']);
  });

  it('combines every filter', () => {
    expect(run({ account: 'card', category: 'Shopping', kind: 'expense', min: 40, q: 'amzn', reviewed: 'unreviewed', from: '2026-09-01' }))
      .toEqual(['AMZN Mktp']);
    expect(run({ account: 'card', kind: 'income', q: 'amzn' })).toEqual([]);
  });
});

describe('applyFilters', () => {
  it('returns matches newest first, keeping same-day order, without mutating the input', () => {
    const before = ids(rows);
    expect(ids(applyFilters(rows, EMPTY_FILTERS))).toEqual(['Refund', 'SQ *BLUE BOTTLE', 'Paycheck', 'Zero', 'Rent', 'AMZN Mktp']);
    expect(ids(rows)).toEqual(before);
  });

  it('stays fast for 5k+ rows', () => {
    const many = Array.from({ length: 20000 }, (_, i) =>
      tx(`t${i}`, `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, (i % 7) - 3.5,
        { merchant: `Merchant ${i % 50}` }));
    const start = performance.now();
    const out = applyFilters(many, f({ q: 'merchant 1', kind: 'expense' }));
    groupByDate(out);
    totals(out);
    expect(out.length).toBeGreaterThan(0);
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe('totals', () => {
  it('counts rows and sums net, income and expense to the cent', () => {
    expect(totals([])).toEqual({ count: 0, net: 0, income: 0, expense: 0 });
    expect(totals([tx('a', '2026-01-01', 0.1), tx('b', '2026-01-01', 0.2), tx('c', '2026-01-01', -0.3)]))
      .toEqual({ count: 3, net: 0, income: 0.3, expense: -0.3 });
    expect(totals(rows)).toEqual({ count: 6, net: 894.5, income: 2442.1, expense: -1547.6 });
  });
});

describe('groupByDate', () => {
  it('groups consecutive same-day rows with a daily total', () => {
    const groups = groupByDate(applyFilters(rows, EMPTY_FILTERS));
    expect(groups.map((g) => [g.date, ids(g.rows), g.total])).toEqual([
      ['2026-10-05', ['Refund'], 42.1],
      ['2026-10-03', ['SQ *BLUE BOTTLE', 'Paycheck'], 2394.5],
      ['2026-10-02', ['Zero'], 0],
      ['2026-10-01', ['Rent'], -1500],
      ['2026-09-28', ['AMZN Mktp'], -42.1],
    ]);
    expect(groupByDate([])).toEqual([]);
  });
});
