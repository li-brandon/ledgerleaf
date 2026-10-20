import { budgetId, currentMonth } from './budget';
import { defaultCategories, ensureCategory, findCategory } from './categories';
import { normalizeRecurring } from './recurring';
import { normalizeRule } from './rules';
import { normalizeSettings } from './settings';
import {
  NON_SPEND, SCHEMA_VERSION, type Account, type Budget, type Budgets, type Category, type CsvMapping, type LedgerState,
  type Transaction,
} from './types';

export const V1_KEY = 'ledgerleaf:v1';
export const V2_KEY = 'ledgerleaf:v2';

/** The shape persisted under `ledgerleaf:v1`. Fields may be missing in old saves. */
export interface LedgerStateV1 {
  accounts?: Account[];
  transactions?: Transaction[];
  budgets?: Budgets;
  lastSync?: string;
}

/** Budgets a fresh ledger starts with (by category name). */
export const DEFAULT_BUDGETS: Budgets = {
  Rent: 1650, Groceries: 500, Dining: 300, Shopping: 250, Transport: 150,
  Utilities: 150, Entertainment: 80, Health: 60,
};

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : []);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** v1 ids are prefixed with the provider id, e.g. `mock-…` or `csv-…`. */
const sourceFromId = (id: string) => /^(mock|csv)-/.exec(id)?.[1];

const MAPPING_COLUMNS = ['amount', 'debit', 'credit', 'category'] as const;

/** A stored CSV mapping with unknown keys dropped, or undefined if it is unusable. */
function normalizeMapping(v: unknown): CsvMapping | undefined {
  if (!isObject(v) || typeof v.date !== 'string' || typeof v.description !== 'string') return undefined;
  const out: CsvMapping = { date: v.date, description: v.description };
  for (const k of MAPPING_COLUMNS) if (typeof v[k] === 'string') out[k] = v[k];
  if (v.negate === true) out.negate = true;
  return out;
}

/**
 * A stored category with every field filled in; undefined when it has no id. Categories
 * saved before the flag existed are excluded from spending if they are Income or Transfer.
 */
function normalizeCategory(v: unknown): Category | undefined {
  if (!isObject(v) || typeof v.id !== 'string' || !v.id) return undefined;
  const name = typeof v.name === 'string' && v.name.trim() ? v.name : v.id;
  const text = (x: unknown, fallback: string) => (typeof x === 'string' && x.trim() ? x : fallback);
  return {
    id: v.id,
    name,
    group: text(v.group, 'Custom'),
    color: text(v.color, '#a0a4ab'),
    icon: text(v.icon, '•'),
    excludeFromSpend: typeof v.excludeFromSpend === 'boolean' ? v.excludeFromSpend : NON_SPEND.has(name),
  };
}

function normalizeCategories(v: unknown): Category[] {
  const seen = new Set<string>();
  const out = list<unknown>(v).flatMap((c) => {
    const cat = normalizeCategory(c);
    if (!cat || seen.has(cat.id)) return [];
    seen.add(cat.id);
    return [cat];
  });
  return out.length ? out : defaultCategories();
}

function normalizeAccount(a: Account): Account {
  return { ...a, currency: a.currency ?? 'USD', hidden: a.hidden ?? false };
}

function normalizeTransaction(t: Transaction, categories: Category[]): Transaction {
  const cat = (t.categoryId && findCategory(categories, t.categoryId)) || ensureCategory(categories, t.category ?? '');
  const out: Transaction = {
    ...t,
    category: cat.name,
    categoryId: cat.id,
    merchant: t.merchant ?? t.description,
    reviewed: t.reviewed ?? false,
  };
  // Edit flags are only ever stored as true.
  if (out.categoryEdited !== true) delete out.categoryEdited;
  if (out.merchantEdited !== true) delete out.merchantEdited;
  const source = t.source ?? sourceFromId(t.id);
  if (source) out.source = source;
  return out;
}

/**
 * Fill v2 defaults and make sure every transaction has a categoryId that exists in
 * `categories` (unknown names become custom categories). Categories gain any missing
 * fields and rules keep only well-formed conditions; rules pointing at a category that no
 * longer exists are dropped. Pure and idempotent.
 */
export function normalizeLedger(s: Partial<LedgerState>): LedgerState {
  const categories = normalizeCategories(s.categories);
  const transactions = list<Transaction>(s.transactions).map((t) => normalizeTransaction(t, categories));
  const categoryIds = new Set(categories.map((c) => c.id));
  const rules = list<unknown>(s.rules).flatMap((r) => normalizeRule(r, categoryIds) ?? []);
  const out: LedgerState = {
    version: SCHEMA_VERSION,
    accounts: list<Account>(s.accounts).map(normalizeAccount),
    transactions,
    categories,
    rules,
    budgets: list(s.budgets),
    balanceSnapshots: list(s.balanceSnapshots),
  };
  if (s.lastSync) out.lastSync = s.lastSync;
  const syncs = isObject(s.syncs) ? Object.entries(s.syncs).filter(([, v]) => isObject(v) && typeof v.lastSync === 'string') : [];
  if (syncs.length) out.syncs = Object.fromEntries(syncs.map(([id, v]) => [id, { lastSync: v.lastSync }]));
  const mappings = isObject(s.importMappings)
    ? Object.entries(s.importMappings).flatMap(([id, v]) => {
      const m = normalizeMapping(v);
      return m ? [[id, m] as const] : [];
    })
    : [];
  if (mappings.length) out.importMappings = Object.fromEntries(mappings);
  const recurring = normalizeRecurring(s.recurring);
  if (recurring) out.recurring = recurring;
  if (isObject(s.settings)) out.settings = normalizeSettings(s.settings);
  return out;
}

/** Convert a v1 save to v2. Legacy budgets (one amount per category name) become Budget records for `month`. */
export function migrateV1(v1: LedgerStateV1, month: string): LedgerState {
  const state = normalizeLedger({ accounts: v1.accounts, transactions: v1.transactions, lastSync: v1.lastSync });
  const legacy = isObject(v1.budgets) ? v1.budgets : DEFAULT_BUDGETS;
  const budgets = new Map<string, Budget>();
  for (const [name, amount] of Object.entries(legacy)) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) continue;
    const { id: categoryId } = ensureCategory(state.categories, name);
    budgets.set(categoryId, { id: budgetId(categoryId, month), categoryId, month, amount, rollover: false });
  }
  return { ...state, budgets: [...budgets.values()] };
}

export const emptyLedger = (month = currentMonth()) => migrateV1({}, month);

/**
 * Bring any persisted shape up to the current schema: v2 data is normalized, anything
 * else is treated as v1, and non-objects yield an empty ledger. Pure: `month` is the
 * month legacy budgets are assigned to.
 */
export function migrate(raw: unknown, month = currentMonth()): LedgerState {
  if (!isObject(raw)) return emptyLedger(month);
  if (raw.version === SCHEMA_VERSION) return normalizeLedger(raw as Partial<LedgerState>);
  return migrateV1(raw as LedgerStateV1, month);
}
