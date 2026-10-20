import { budgetId } from './budget';
import { slug } from './csv';
import { CATEGORIES, NON_SPEND, type Category, type LedgerState } from './types';

type Seed = Omit<Category, 'id' | 'name' | 'excludeFromSpend'>;

const SEED: Record<(typeof CATEGORIES)[number], Seed> = {
  Groceries: { group: 'Essentials', color: '#4f9a5b', icon: '🛒' },
  Dining: { group: 'Lifestyle', color: '#d9822b', icon: '🍽️' },
  Transport: { group: 'Essentials', color: '#3b7dd8', icon: '🚌' },
  Shopping: { group: 'Lifestyle', color: '#b0549a', icon: '🛍️' },
  Utilities: { group: 'Essentials', color: '#2a9d9a', icon: '💡' },
  Rent: { group: 'Essentials', color: '#7a5cc4', icon: '🏠' },
  Entertainment: { group: 'Lifestyle', color: '#d4a72c', icon: '🎬' },
  Health: { group: 'Essentials', color: '#d1495b', icon: '💊' },
  Travel: { group: 'Lifestyle', color: '#3fa7d6', icon: '✈️' },
  Income: { group: 'Income', color: '#2e8b57', icon: '💰' },
  Transfer: { group: 'Transfers', color: '#8a8f98', icon: '🔁' },
  Other: { group: 'Other', color: '#a0a4ab', icon: '•' },
};

export const categoryId = (name: string) => slug(name);

/** Built-in categories, seeded from CATEGORIES. */
export const defaultCategories = (): Category[] =>
  CATEGORIES.map((name) => ({ id: categoryId(name), name, ...SEED[name], excludeFromSpend: NON_SPEND.has(name) }));

/** A user category created for a name not in the list (e.g. from a CSV import). */
export const customCategory = (name: string): Category => ({
  id: categoryId(name), name, group: 'Custom', color: '#a0a4ab', icon: '•', excludeFromSpend: false,
});

/**
 * Find a category by id or (case-insensitive) name. An exact id wins, then a name, so a
 * new category can reuse the name a renamed one was created with.
 */
export function findCategory(categories: Category[], nameOrId: string): Category | undefined {
  const raw = nameOrId.trim();
  const key = raw.toLowerCase();
  return categories.find((c) => c.id === raw)
    ?? categories.find((c) => c.name.toLowerCase() === key)
    ?? categories.find((c) => c.id === key || c.id === categoryId(nameOrId));
}

/**
 * Resolve a category name, appending a custom category if it is unknown.
 * Blank names resolve to Other. Mutates `categories`.
 */
export function ensureCategory(categories: Category[], name: string): Category {
  const n = name.trim() || 'Other';
  const found = findCategory(categories, n);
  if (found) return found;
  const created = customCategory(n);
  categories.push(created);
  return created;
}

/** The editable fields of a category. */
export type CategoryDraft = Omit<Category, 'id'>;

const HEX = /^#[0-9a-f]{6}$/i;

/** A slug id for `name` that no category in `categories` uses yet. */
export function newCategoryId(categories: readonly Category[], name: string): string {
  const taken = new Set(categories.map((c) => c.id));
  const base = categoryId(name);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Why `draft` cannot be saved (as a new category, or as `editingId`), or undefined. */
export function validateCategory(draft: CategoryDraft, categories: readonly Category[], editingId?: string): string | undefined {
  const name = draft.name.trim();
  if (!name) return 'Give the category a name.';
  if (categories.some((c) => c.id !== editingId && c.name.trim().toLowerCase() === name.toLowerCase())) {
    return `There is already a category called “${name}”.`;
  }
  if (!HEX.test(draft.color)) return 'Pick a color.';
  return undefined;
}

const tidy = (d: CategoryDraft): CategoryDraft => ({
  name: d.name.trim(),
  group: d.group.trim() || 'Custom',
  color: d.color,
  icon: d.icon.trim() || '•',
  excludeFromSpend: d.excludeFromSpend,
});

/** Add a category; throws if the draft is invalid. */
export function addCategory(state: LedgerState, draft: CategoryDraft): LedgerState {
  const problem = validateCategory(draft, state.categories);
  if (problem) throw new Error(problem);
  const d = tidy(draft);
  return { ...state, categories: [...state.categories, { id: newCategoryId(state.categories, d.name), ...d }] };
}

/**
 * Edit a category; throws if the draft is invalid. Its id never changes, so budgets and
 * rules follow along; transactions get the new name.
 */
export function updateCategory(state: LedgerState, id: string, draft: CategoryDraft): LedgerState {
  const prev = state.categories.find((c) => c.id === id);
  if (!prev) return state;
  const problem = validateCategory(draft, state.categories, id);
  if (problem) throw new Error(problem);
  const next: Category = { id, ...tidy(draft) };
  const same = (Object.keys(next) as (keyof Category)[]).every((k) => next[k] === prev[k]);
  if (same) return state;
  const categories = state.categories.map((c) => (c.id === id ? next : c));
  const transactions = next.name === prev.name
    ? state.transactions
    : state.transactions.map((t) => (t.categoryId === id ? { ...t, category: next.name } : t));
  return { ...state, categories, transactions };
}

/** What refers to a category. */
export interface CategoryUsage {
  transactions: number;
  budgets: number;
  rules: number;
}

export function categoryUsage(state: Pick<LedgerState, 'transactions' | 'budgets' | 'rules'>, id: string): CategoryUsage {
  const count = <T extends { categoryId?: string }>(xs: readonly T[]) => xs.reduce((n, x) => (x.categoryId === id ? n + 1 : n), 0);
  return { transactions: count(state.transactions), budgets: count(state.budgets), rules: count(state.rules) };
}

export const inUse = (u: CategoryUsage) => u.transactions + u.budgets + u.rules > 0;

/**
 * Delete a category. One that is in use needs `reassignTo`, another category that takes
 * over its transactions and rules. Its budgets move over too, unless the target already
 * has a budget of its own, which is kept as it is. Throws when the delete is not allowed.
 */
export function deleteCategory(state: LedgerState, id: string, reassignTo?: string): LedgerState {
  if (!state.categories.some((c) => c.id === id)) return state;
  if (state.categories.length === 1) throw new Error('Keep at least one category.');
  const used = inUse(categoryUsage(state, id));
  const target = reassignTo === undefined ? undefined : state.categories.find((c) => c.id === reassignTo);
  if (reassignTo !== undefined && (!target || target.id === id)) throw new Error('Choose another category to move to.');
  if (used && !target) throw new Error('This category is in use. Choose a category to move its transactions, budgets and rules to.');

  const categories = state.categories.filter((c) => c.id !== id);
  if (!used || !target) return { ...state, categories };
  const transactions = state.transactions.map((t) =>
    (t.categoryId === id ? { ...t, categoryId: target.id, category: target.name } : t));
  const rules = state.rules.map((r) => (r.categoryId === id ? { ...r, categoryId: target.id } : r));
  const targetHasBudget = state.budgets.some((b) => b.categoryId === target.id);
  const budgets = state.budgets.flatMap((b) => {
    if (b.categoryId !== id) return [b];
    return targetHasBudget ? [] : [{ ...b, categoryId: target.id, id: budgetId(target.id, b.month) }];
  });
  return { ...state, categories, transactions, rules, budgets };
}
