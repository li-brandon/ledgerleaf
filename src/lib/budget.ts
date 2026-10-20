import { NON_SPEND, type Budgets, type Transaction } from './types';

export const monthKey = (date: string) => date.slice(0, 7);

export const currentMonth = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

export const isSpend = (t: Transaction) => t.amount < 0 && !NON_SPEND.has(t.category);

/** Net spend per category for a month (refunds within a spend category reduce it). */
export function spendByCategory(txns: Transaction[], month: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of txns) {
    if (monthKey(t.date) !== month || NON_SPEND.has(t.category)) continue;
    out[t.category] = (out[t.category] ?? 0) - t.amount;
  }
  for (const k of Object.keys(out)) out[k] = round(Math.max(0, out[k]));
  return out;
}

export type BudgetStatus = 'ok' | 'near' | 'over';

export interface BudgetLine {
  category: string;
  budget: number;
  spent: number;
  remaining: number;
  /** spent / budget, 0..∞ (Infinity when spending without a budget). */
  ratio: number;
  status: BudgetStatus;
}

export function budgetProgress(budgets: Budgets, txns: Transaction[], month: string): BudgetLine[] {
  const spent = spendByCategory(txns, month);
  const cats = new Set([...Object.keys(budgets).filter((c) => budgets[c] > 0), ...Object.keys(spent)]);
  return [...cats]
    .map((category) => {
      const budget = budgets[category] ?? 0;
      const s = spent[category] ?? 0;
      const ratio = budget > 0 ? s / budget : s > 0 ? Infinity : 0;
      const status: BudgetStatus = ratio > 1 ? 'over' : ratio >= 0.85 ? 'near' : 'ok';
      return { category, budget, spent: s, remaining: round(budget - s), ratio, status };
    })
    .sort((a, b) => b.budget - a.budget || b.spent - a.spent);
}

export function budgetTotals(lines: BudgetLine[]) {
  return {
    budgeted: round(lines.reduce((s, l) => s + l.budget, 0)),
    spent: round(lines.reduce((s, l) => s + l.spent, 0)),
  };
}

export const round = (n: number) => Math.round(n * 100) / 100;
