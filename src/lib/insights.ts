import { isSpend, monthKey, round } from './budget';
import type { Account, Transaction } from './types';

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

/** Gross spend per month and category for the given months (missing months are zero). */
export function monthlySpend(txns: Transaction[], months: string[]): MonthSpend[] {
  const map = new Map(months.map((m) => [m, { month: m, total: 0, byCategory: {} as Record<string, number> }]));
  for (const t of txns) {
    const row = map.get(monthKey(t.date));
    if (!row || !isSpend(t)) continue;
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

export function topMerchants(txns: Transaction[], limit = 5, months?: string[]): Merchant[] {
  const by = new Map<string, Merchant>();
  for (const t of txns) {
    if (!isSpend(t) || (months && !months.includes(monthKey(t.date)))) continue;
    const m = by.get(t.description) ?? { name: t.description, total: 0, count: 0 };
    m.total = round(m.total - t.amount);
    m.count++;
    by.set(t.description, m);
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
