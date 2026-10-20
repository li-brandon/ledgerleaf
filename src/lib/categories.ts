import { slug } from './csv';
import { CATEGORIES, NON_SPEND, type Category } from './types';

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

/** Find a category by id or (case-insensitive) name. */
export function findCategory(categories: Category[], nameOrId: string): Category | undefined {
  const key = nameOrId.trim().toLowerCase();
  return categories.find((c) => c.id === key || c.name.toLowerCase() === key)
    ?? categories.find((c) => c.id === categoryId(nameOrId));
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
