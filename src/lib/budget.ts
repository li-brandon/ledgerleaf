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

export const round = (n: number) => Math.round(n * 100) / 100;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Whether `s` is a YYYY-MM month key. */
export const isMonthKey = (s: string | undefined): s is string => !!s && MONTH.test(s);

/** The month `n` months after `month` (before, when negative). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  return currentMonth(new Date(y, m - 1 + n, 1));
}

/** The budget record in effect for a category in `month`: its latest record on or before it. */
export function budgetAt(budgets: readonly Budget[], categoryId: string, month: string): Budget | undefined {
  let found: Budget | undefined;
  for (const b of budgets) {
    if (b.categoryId === categoryId && b.month <= month && (!found || b.month > found.month)) found = b;
  }
  return found;
}

/**
 * Change a category's amount and/or rollover from `month` on; later months without a
 * record of their own follow it, which is how a new month copies the one before. Months
 * up to `current` are history, so editing a past month pins the following month to what
 * it was before, leaving later months as they were.
 */
export function setMonthBudget(
  budgets: Budget[], categoryId: string, month: string, patch: { amount?: number; rollover?: boolean },
  current = currentMonth(),
): Budget[] {
  const prior = budgetAt(budgets, categoryId, month);
  const id = budgetId(categoryId, month);
  const next: Budget = {
    id, categoryId, month, amount: patch.amount ?? prior?.amount ?? 0, rollover: patch.rollover ?? prior?.rollover ?? false,
  };
  const out = [...budgets.filter((b) => b.id !== id), next];
  const after = addMonths(month, 1);
  if (month < current && !budgets.some((b) => b.categoryId === categoryId && b.month === after)) {
    const kept = budgetAt(budgets, categoryId, after);
    out.push({ id: budgetId(categoryId, after), categoryId, month: after, amount: kept?.amount ?? 0, rollover: kept?.rollover ?? false });
  }
  return out;
}

/** One category's money for one month. */
export interface MonthFigures {
  /** The amount set for the month. */
  budgeted: number;
  /** Whether this month's leftover (or overspend) carries into the next month. */
  rollover: boolean;
  /** Carried in from the previous month: positive when it was underspent, negative when overspent. */
  carry: number;
  /** budgeted + carry. */
  available: number;
  spent: number;
  /** available − spent; negative when over. */
  remaining: number;
}

/**
 * A category's figures for `month`, following rollover month by month from its first
 * budget record. A month with rollover on passes its remaining amount (negative when
 * overspent) to the next month's available; with rollover off the chain starts again.
 */
export function rolloverMonth(records: readonly Budget[], spentIn: (month: string) => number, month: string): MonthFigures {
  const own = records.filter((b) => b.month <= month).sort((a, b) => a.month.localeCompare(b.month));
  let carry = 0;
  let i = -1;
  for (let m = own[0]?.month ?? month; ; m = addMonths(m, 1)) {
    while (i + 1 < own.length && own[i + 1].month <= m) i++;
    const rec = own[i];
    const budgeted = rec?.amount ?? 0;
    const available = round(budgeted + carry);
    const spent = round(spentIn(m));
    const remaining = round(available - spent);
    if (m >= month) return { budgeted, rollover: rec?.rollover ?? false, carry, available, spent, remaining };
    carry = rec?.rollover ? remaining : 0;
  }
}

/** Category id a transaction is filed under. */
const txCategoryId = (t: Transaction) => t.categoryId ?? slug(t.category);

/** Net spend per month and category id (refunds reduce it, never below zero). */
export function spendByMonth(
  txns: readonly Transaction[], excluded: SpendExclusions = DEFAULT_EXCLUSIONS,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const t of txns) {
    if (isExcluded(t, excluded)) continue;
    const m = monthKey(t.date);
    const row = out.get(m) ?? out.set(m, new Map()).get(m)!;
    const id = txCategoryId(t);
    row.set(id, (row.get(id) ?? 0) - t.amount);
  }
  for (const row of out.values()) for (const [k, v] of row) row.set(k, round(Math.max(0, v)));
  return out;
}

/** Share of `month` that has passed by `today`: 0 before it starts, 1 once it is over. */
export function monthElapsed(month: string, today = new Date()): number {
  const now = currentMonth(today);
  if (month < now) return 1;
  if (month > now) return 0;
  const [y, m] = month.split('-').map(Number);
  return today.getDate() / new Date(y, m, 0).getDate();
}

export interface BudgetRow extends MonthFigures {
  categoryId: string;
  category: string;
  /** spent / available, 0..∞ (Infinity when spending with nothing available). */
  ratio: number;
  status: BudgetStatus;
  /** What spending at an even pace would add up to by today. */
  expected: number;
}

/**
 * Every budgeted (or spent-in) category for `month`, with rollover and pace. Categories
 * excluded from spending are left out.
 */
export function monthBudget(
  state: { budgets: readonly Budget[]; categories: readonly Category[]; transactions: readonly Transaction[] },
  month: string, today = new Date(),
): BudgetRow[] {
  const excluded = spendExclusions([...state.categories]);
  const spend = spendByMonth(state.transactions, excluded);
  const names = new Map(state.categories.map((c) => [c.id, c.name]));
  for (const t of state.transactions) if (!names.has(txCategoryId(t))) names.set(txCategoryId(t), t.category);
  const records = new Map<string, Budget[]>();
  for (const b of state.budgets) {
    if (!excluded.has(b.categoryId)) records.set(b.categoryId, [...(records.get(b.categoryId) ?? []), b]);
  }
  const ids = new Set([...records.keys(), ...(spend.get(month)?.keys() ?? [])]);
  const elapsed = monthElapsed(month, today);
  const rows: BudgetRow[] = [];
  for (const categoryId of ids) {
    const f = rolloverMonth(records.get(categoryId) ?? [], (m) => spend.get(m)?.get(categoryId) ?? 0, month);
    if (!f.budgeted && !f.carry && !f.spent) continue;
    const ratio = f.available > 0 ? f.spent / f.available : f.spent > 0 ? Infinity : 0;
    const status: BudgetStatus = ratio > 1 ? 'over' : ratio >= 0.85 ? 'near' : 'ok';
    const expected = round(Math.max(0, f.available) * elapsed);
    rows.push({ ...f, categoryId, category: names.get(categoryId) ?? categoryId, ratio, status, expected });
  }
  return rows.sort((a, b) => b.available - a.available || b.spent - a.spent || a.category.localeCompare(b.category));
}

export interface BudgetSummary {
  budgeted: number;
  carry: number;
  available: number;
  spent: number;
  remaining: number;
  expected: number;
}

export function monthTotals(rows: readonly BudgetRow[]): BudgetSummary {
  const sum = (k: keyof BudgetSummary) => round(rows.reduce((s, r) => s + r[k], 0));
  return {
    budgeted: sum('budgeted'), carry: sum('carry'), available: sum('available'),
    spent: sum('spent'), remaining: sum('remaining'), expected: sum('expected'),
  };
}
