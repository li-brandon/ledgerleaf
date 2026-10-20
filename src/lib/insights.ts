import { DEFAULT_EXCLUSIONS, addMonths, isSpend, monthKey, round, type SpendExclusions } from './budget';
import { EMPTY_FILTERS, filtersHref } from './txFilters';
import type { Account, BalanceSnapshot, Transaction } from './types';

export interface MonthSpend {
  month: string;
  total: number;
  byCategory: Record<string, number>;
}

/** Previous `n` month keys ending at `month` (inclusive), oldest first. */
export function monthRange(month: string, n: number): string[] {
  const [y, m] = month.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(y, m - 1 - (n - 1 - i), 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
}

/**
 * Gross spend per month and category for the given months (missing months are zero).
 * Categories in `excluded` are left out.
 */
export function monthlySpend(txns: Transaction[], months: string[], excluded: SpendExclusions = DEFAULT_EXCLUSIONS): MonthSpend[] {
  const map = new Map(months.map((m) => [m, { month: m, total: 0, byCategory: {} as Record<string, number> }]));
  for (const t of txns) {
    const row = map.get(monthKey(t.date));
    if (!row || !isSpend(t, excluded)) continue;
    row.total = round(row.total - t.amount);
    row.byCategory[t.category] = round((row.byCategory[t.category] ?? 0) - t.amount);
  }
  return [...map.values()];
}

/** Categories ranked by total spend across the given rows. */
export function rankCategories(rows: MonthSpend[]): string[] {
  const totals: Record<string, number> = {};
  for (const r of rows) for (const [c, v] of Object.entries(r.byCategory)) totals[c] = (totals[c] ?? 0) + v;
  return Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
}

export interface CategoryShare {
  category: string;
  total: number;
  /** Fraction of all spend in the period, 0..1. */
  share: number;
}

/** Spend per category summed over `rows`, biggest first, with each category's share of the total. */
export function categoryShares(rows: MonthSpend[]): CategoryShare[] {
  const totals: Record<string, number> = {};
  for (const r of rows) for (const [c, v] of Object.entries(r.byCategory)) totals[c] = round((totals[c] ?? 0) + v);
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  return Object.entries(totals)
    .filter(([, v]) => v > 0)
    .map(([category, total]) => ({ category, total, share: sum > 0 ? total / sum : 0 }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));
}

/** One point per row: spend in `category`, or total spend when no category is given. */
export const categoryTrend = (rows: MonthSpend[], category?: string) =>
  rows.map((r) => ({ month: r.month, value: category ? r.byCategory[category] ?? 0 : r.total }));

/** Relative change from `base` to `value` (0.1 = +10%), or null when there is no base to compare with. */
export const pctChange = (value: number, base: number): number | null =>
  base > 0 ? (value - base) / base : null;

/** How many earlier months the month-over-month average covers. */
export const AVERAGE_MONTHS = 3;

export interface MonthCompare {
  category: string;
  current: number;
  previous: number;
  /** Mean spend over the {@link AVERAGE_MONTHS} months before `month`. */
  average: number;
  vsPrevious: number | null;
  vsAverage: number | null;
}

const compare = (category: string, current: number, previous: number, average: number): MonthCompare => ({
  category, current, previous, average, vsPrevious: pctChange(current, previous), vsAverage: pctChange(current, average),
});

/**
 * Spend in `month` against the month before and the average of the {@link AVERAGE_MONTHS}
 * months before it, per category (biggest this month first) and in total.
 */
export function monthOverMonth(
  txns: Transaction[], month: string, excluded: SpendExclusions = DEFAULT_EXCLUSIONS,
): { rows: MonthCompare[]; total: MonthCompare } {
  const [cur, ...before] = monthlySpend(txns, monthRange(month, AVERAGE_MONTHS + 1), excluded).reverse();
  const avg = (pick: (r: MonthSpend) => number) => round(before.reduce((s, r) => s + pick(r), 0) / before.length);
  const cats = new Set([cur, ...before].flatMap((r) => Object.keys(r.byCategory)));
  const rows = [...cats]
    .map((c) => compare(c, cur.byCategory[c] ?? 0, before[0].byCategory[c] ?? 0, avg((r) => r.byCategory[c] ?? 0)))
    .sort((a, b) => b.current - a.current || b.average - a.average || a.category.localeCompare(b.category));
  return { rows, total: compare('Total', cur.total, before[0].total, avg((r) => r.total)) };
}

/** First and last ISO dates covered by a list of month keys. */
export function monthsSpan(months: string[]): { from: string; to: string } {
  const sorted = [...months].sort();
  const last = sorted[sorted.length - 1];
  const lastDay = new Date(`${addMonths(last, 1)}-01T00:00:00`);
  lastDay.setDate(0);
  return { from: `${sorted[0]}-01`, to: `${last}-${String(lastDay.getDate()).padStart(2, '0')}` };
}

/**
 * The Transactions list showing the spending behind an insight: money out in `months`,
 * optionally in one category (or any of several, e.g. those folded into a chart's "Other") or at one merchant.
 */
export function spendHref(months: string[], by: { category?: string | readonly string[]; merchant?: string } = {}): string {
  const category = typeof by.category === 'string' ? by.category : (by.category ?? []).join(',');
  return filtersHref({ ...EMPTY_FILTERS, ...monthsSpan(months), kind: 'expense', category, q: by.merchant ?? '' });
}

export interface Merchant {
  name: string;
  total: number;
  count: number;
}

/** Biggest merchants by spend (renamed merchants are grouped under their new name). */
export function topMerchants(
  txns: Transaction[], limit = 5, months?: string[], excluded: SpendExclusions = DEFAULT_EXCLUSIONS,
): Merchant[] {
  const by = new Map<string, Merchant>();
  for (const t of txns) {
    if (!isSpend(t, excluded) || (months && !months.includes(monthKey(t.date)))) continue;
    const name = t.merchant ?? t.description;
    const m = by.get(name) ?? { name, total: 0, count: 0 };
    m.total = round(m.total - t.amount);
    m.count++;
    by.set(name, m);
  }
  return [...by.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

/** Account balance: provider-reported if known, else the sum of its transactions. */
export function accountBalance(account: Account, txns: Transaction[]): number {
  if (account.balance !== undefined) return account.balance;
  return round(txns.reduce((s, t) => (t.accountId === account.id ? s + t.amount : s), 0));
}

export const netBalance = (accounts: Account[], txns: Transaction[]) =>
  round(accounts.reduce((s, a) => s + accountBalance(a, txns), 0));

export interface NetWorthPoint {
  month: string;
  total: number;
}

/**
 * Net worth at the end of each month that has a balance snapshot, oldest first: each
 * visible account's latest snapshot so far, carried forward through months without one.
 */
export function netWorthByMonth(accounts: Account[], snapshots: BalanceSnapshot[]): NetWorthPoint[] {
  const visible = new Set(accounts.filter((a) => !a.hidden).map((a) => a.id));
  const sorted = snapshots.filter((s) => visible.has(s.accountId)).sort((a, b) => a.date.localeCompare(b.date));
  const latest = new Map<string, number>();
  const points: NetWorthPoint[] = [];
  for (const s of sorted) {
    latest.set(s.accountId, s.balance);
    const month = monthKey(s.date);
    const total = round([...latest.values()].reduce((a, b) => a + b, 0));
    if (points.at(-1)?.month === month) points[points.length - 1].total = total;
    else points.push({ month, total });
  }
  return points;
}
