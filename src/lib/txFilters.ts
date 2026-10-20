/**
 * Transactions list filters: parsing from and serialising to the route's query parameters,
 * matching, newest-first ordering, date grouping and totals. Pure, so it can be unit tested.
 */
import { routeHref, type RouteParams } from './routes';
import type { Transaction } from './types';

export type ReviewFilter = '' | 'reviewed' | 'unreviewed';
/** Income is money in (amount > 0), expense is money out (amount < 0). */
export type KindFilter = '' | 'income' | 'expense';

export interface TxFilters {
  /** Free text, matched case-insensitively against description, merchant and notes. */
  q: string;
  /** Inclusive ISO dates (YYYY-MM-DD); empty means unbounded. */
  from: string;
  to: string;
  /** Account id. */
  account: string;
  /** Category name (case-insensitive) or id. */
  category: string;
  /** Inclusive bounds on the absolute amount. */
  min?: number;
  max?: number;
  reviewed: ReviewFilter;
  kind: KindFilter;
}

export const EMPTY_FILTERS: TxFilters = {
  q: '', from: '', to: '', account: '', category: '', reviewed: '', kind: '',
};

/** Rows shown per page of the list. */
export const PAGE_SIZE = 100;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isDate = (s: string | undefined): s is string =>
  !!s && ISO_DATE.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());

/** A non-negative amount, or undefined for blank or invalid input. */
export function parseAmount(s: string | undefined): number | undefined {
  if (s == null || s.trim() === '') return undefined;
  const n = Number(s.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Filters from route parameters (`q`, `from`, `to`, `account`, `category`, `min`, `max`, `reviewed`, `type`). Invalid values are ignored. */
export function parseFilters(params: RouteParams): TxFilters {
  const { q, from, to, account, category, min, max, reviewed, type } = params;
  return {
    q: q ?? '',
    from: isDate(from) ? from : '',
    to: isDate(to) ? to : '',
    account: account ?? '',
    category: category ?? '',
    min: parseAmount(min),
    max: parseAmount(max),
    reviewed: reviewed === 'reviewed' || reviewed === 'unreviewed' ? reviewed : '',
    kind: type === 'income' || type === 'expense' ? type : '',
  };
}

/** Route parameters for a set of filters, in a stable order; unset filters are left out. */
export function filtersToParams(f: TxFilters): RouteParams {
  const out: RouteParams = {};
  const set = (k: string, v: string | number | undefined) => {
    if (v !== undefined && v !== '') out[k] = String(v);
  };
  set('q', f.q.trim());
  set('account', f.account);
  set('category', f.category);
  set('from', f.from);
  set('to', f.to);
  set('min', f.min);
  set('max', f.max);
  set('reviewed', f.reviewed);
  set('type', f.kind);
  return out;
}

/** The hash for the transactions list with these filters, e.g. `#/transactions?q=coffee&type=expense`. */
export const filtersHref = (f: TxFilters) => routeHref('transactions', filtersToParams(f));

/** A key that is equal for filters that select the same rows. */
export const filtersKey = (f: TxFilters) => filtersHref(f);

/** How many filters are set; the search text counts as one. */
export const activeFilterCount = (f: TxFilters) => Object.keys(filtersToParams(f)).length;

export const hasFilters = (f: TxFilters) => activeFilterCount(f) > 0;

/** A predicate for the filters. Reversed date or amount bounds are swapped. */
export function matcher(f: TxFilters): (t: Transaction) => boolean {
  const needle = f.q.trim().toLowerCase();
  const [from, to] = f.from && f.to && f.from > f.to ? [f.to, f.from] : [f.from, f.to];
  const [min, max] = f.min !== undefined && f.max !== undefined && f.min > f.max ? [f.max, f.min] : [f.min, f.max];
  const category = f.category.trim().toLowerCase();
  return (t) => {
    if (f.account && t.accountId !== f.account) return false;
    if (category && t.category.toLowerCase() !== category && t.categoryId !== category) return false;
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    const abs = Math.abs(t.amount);
    if (min !== undefined && abs < min) return false;
    if (max !== undefined && abs > max) return false;
    if (f.reviewed === 'reviewed' && !t.reviewed) return false;
    if (f.reviewed === 'unreviewed' && t.reviewed) return false;
    if (f.kind === 'income' && !(t.amount > 0)) return false;
    if (f.kind === 'expense' && !(t.amount < 0)) return false;
    if (needle && !(
      t.description.toLowerCase().includes(needle)
      || !!t.merchant?.toLowerCase().includes(needle)
      || !!t.notes?.toLowerCase().includes(needle)
    )) return false;
    return true;
  };
}

/** Matching transactions, newest first; same-day rows keep their original order. */
export function applyFilters(transactions: readonly Transaction[], f: TxFilters): Transaction[] {
  const match = matcher(f);
  const rows = transactions.filter(match);
  // Array.prototype.sort is stable, so equal dates keep their input order.
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export interface Totals {
  count: number;
  /** Signed sum of every row. */
  net: number;
  /** Sum of positive amounts. */
  income: number;
  /** Sum of negative amounts (≤ 0). */
  expense: number;
}

/** Count and sums of a list, rounded to cents to avoid floating point drift. */
export function totals(rows: readonly Transaction[]): Totals {
  let income = 0;
  let expense = 0;
  for (const t of rows) {
    if (t.amount > 0) income += t.amount;
    else expense += t.amount;
  }
  const cents = (n: number) => Math.round(n * 100) / 100 || 0;
  return { count: rows.length, net: cents(income + expense), income: cents(income), expense: cents(expense) };
}

export interface DateGroup {
  date: string;
  rows: Transaction[];
  /** Signed sum of the group's rows. */
  total: number;
}

/** Consecutive rows with the same date, in input order (pass rows already sorted by date). */
export function groupByDate(rows: readonly Transaction[]): DateGroup[] {
  const groups: DateGroup[] = [];
  for (const t of rows) {
    const last = groups[groups.length - 1];
    if (last && last.date === t.date) last.rows.push(t);
    else groups.push({ date: t.date, rows: [t], total: 0 });
  }
  for (const g of groups) g.total = totals(g.rows).net;
  return groups;
}
