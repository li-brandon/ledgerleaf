import { DEFAULT_EXCLUSIONS, isSpend, monthKey, round, type SpendExclusions } from './budget';
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
