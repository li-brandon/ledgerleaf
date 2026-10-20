export type AccountType = 'checking' | 'savings' | 'credit' | 'investment' | 'loan';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  /** Explicit balance from the provider; when absent it is derived from transactions. */
  balance?: number;
  institution?: string;
  /** ISO 4217 code, e.g. 'USD'. */
  currency?: string;
  /** Hidden accounts are kept but excluded from views. */
  hidden?: boolean;
}

/** Point-in-time account balance, used for net worth history. */
export interface BalanceSnapshot {
  accountId: string;
  /** ISO date, YYYY-MM-DD */
  date: string;
  balance: number;
}

export interface Transaction {
  id: string;
  /** ISO date, YYYY-MM-DD */
  date: string;
  description: string;
  /** Negative = money out, positive = money in. */
  amount: number;
  /** Legacy category name; kept in sync with `categoryId`. */
  category: string;
  accountId: string;
  categoryId?: string;
  merchant?: string;
  notes?: string;
  reviewed?: boolean;
  /** Provider id that produced this transaction, e.g. 'mock' or 'csv'. */
  source?: string;
  /** The provider's own id for this transaction. */
  externalId?: string;
}

export interface Category {
  id: string;
  name: string;
  group: string;
  color: string;
  icon: string;
  /** Never counted as spending (e.g. income, transfers). */
  excludeFromSpend: boolean;
}

/** Auto-categorisation rule. Every condition that is set must match. */
export interface Rule {
  id: string;
  /** Case-insensitive exact merchant match. */
  merchant?: string;
  /** Case-insensitive substring of the description. */
  descriptionContains?: string;
  /** Inclusive amount bounds (signed, same convention as Transaction.amount). */
  amountMin?: number;
  amountMax?: number;
  categoryId: string;
}

/** Budget for one category, effective from `month` until a later record replaces it. */
export interface Budget {
  id: string;
  categoryId: string;
  /** YYYY-MM */
  month: string;
  amount: number;
  /** Carry unspent (or overspent) amounts into the next month. */
  rollover: boolean;
}

/** Monthly budget amount per category name. */
export type Budgets = Record<string, number>;

/** Sync bookkeeping for one provider. */
export interface ProviderSyncState {
  /** ISO timestamp of the last successful sync. */
  lastSync: string;
}

/**
 * Which CSV columns (by header name) hold each transaction field. Amounts come from one
 * signed `amount` column, or from separate `debit` (money out) and `credit` (money in)
 * columns when `amount` is unset.
 */
export interface CsvMapping {
  date: string;
  description: string;
  amount?: string;
  debit?: string;
  credit?: string;
  category?: string;
  /** The file shows spending as positive (common on card statements): flip every sign. */
  negate?: boolean;
}

export const SCHEMA_VERSION = 2;

export interface LedgerState {
  version: typeof SCHEMA_VERSION;
  accounts: Account[];
  transactions: Transaction[];
  categories: Category[];
  rules: Rule[];
  budgets: Budget[];
  balanceSnapshots: BalanceSnapshot[];
  /** Last successful sync from any provider. */
  lastSync?: string;
  /** Per-provider sync state, keyed by provider id. */
  syncs?: Record<string, ProviderSyncState>;
  /** Column mapping last used to import a CSV into each account, keyed by account id. */
  importMappings?: Record<string, CsvMapping>;
}

export const CATEGORIES = [
  'Groceries', 'Dining', 'Transport', 'Shopping', 'Utilities', 'Rent',
  'Entertainment', 'Health', 'Travel', 'Income', 'Transfer', 'Other',
] as const;

/** Categories that never count as spending. */
export const NON_SPEND = new Set(['Income', 'Transfer']);
