import { slug } from './csv';
import { NON_SPEND, type Budget, type Budgets, type Category, type Transaction } from './types';

export const monthKey = (date: string) => date.slice(0, 7);

export const currentMonth = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

/** Ids of categories that never count as spending. */
export type SpendExclusions = ReadonlySet<string>;

/** The built-in exclusions (Income and Transfer), for callers without a category list. */
export const DEFAULT_EXCLUSIONS: SpendExclusions = new Set([...NON_SPEND].map(slug));

/** Ids of the categories flagged "exclude from spending". */
export const spendExclusions = (categories: readonly Category[]): SpendExclusions =>
  new Set(categories.filter((c) => c.excludeFromSpend).map((c) => c.id));

/** Whether `t`'s category is excluded from spending. */
export const isExcluded = (t: Transaction, excluded: SpendExclusions = DEFAULT_EXCLUSIONS) =>
  excluded.has(t.categoryId ?? slug(t.category));

export const isSpend = (t: Transaction, excluded: SpendExclusions = DEFAULT_EXCLUSIONS) =>
  t.amount < 0 && !isExcluded(t, excluded);

/** Net spend per category for a month (refunds within a spend category reduce it). */
export function spendByCategory(
  txns: Transaction[], month: string, excluded: SpendExclusions = DEFAULT_EXCLUSIONS,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of txns) {
    if (monthKey(t.date) !== month || isExcluded(t, excluded)) continue;
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

export function budgetProgress(
  budgets: Budgets, txns: Transaction[], month: string, excluded: SpendExclusions = DEFAULT_EXCLUSIONS,
): BudgetLine[] {
  const spent = spendByCategory(txns, month, excluded);
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

export const budgetId = (categoryId: string, month: string) => `${categoryId}:${month}`;

/**
 * Budget amounts in effect for `month`, keyed by category name: per category, the
 * latest record whose month is on or before `month`. Categories excluded from spending
 * have no budget.
 */
export function budgetsForMonth(budgets: Budget[], categories: Category[], month: string): Budgets {
  const latest = new Map<string, Budget>();
  const excluded = spendExclusions(categories);
  for (const b of budgets) {
    if (excluded.has(b.categoryId)) continue;
    const prev = latest.get(b.categoryId);
    if (b.month <= month && (!prev || b.month > prev.month)) latest.set(b.categoryId, b);
  }
  const name = new Map(categories.map((c) => [c.id, c.name]));
  return Object.fromEntries([...latest.values()].map((b) => [name.get(b.categoryId) ?? b.categoryId, b.amount]));
}

/** Set a category's budget from `month` on, keeping the rollover flag of the record it replaces. */
export function upsertBudget(budgets: Budget[], categoryId: string, month: string, amount: number): Budget[] {
  const id = budgetId(categoryId, month);
  const prior = budgets
    .filter((b) => b.categoryId === categoryId && b.month <= month)
    .sort((a, b) => b.month.localeCompare(a.month))[0];
  const next: Budget = { id, categoryId, month, amount, rollover: prior?.rollover ?? false };
  return [...budgets.filter((b) => b.id !== id), next];
}

export const round =(n: number) => Math.round(n * 100) / 100;
