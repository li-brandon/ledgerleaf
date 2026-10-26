import type { Settings } from './settings';

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
  /** The user renamed the account; a re-sync keeps their name. */
  renamed?: boolean;
  /** Provider id that created this account, e.g. 'demo' or 'csv'. */
  source?: string;
}

/** Point-in-time account balance, used for net worth history. */
export interface BalanceSnapshot {
  accountId: string;
  /** ISO date, YYYY-MM-DD */
  date: string;
  balance: number;
  /** Provider id that reported this balance. */
  source?: string;
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
  /** Provider id that produced this transaction, e.g. 'demo' or 'csv'. */
  source?: string;
  /** The provider's own id for this transaction. */
  externalId?: string;
  /** The bank has not posted it yet (providers that report it, e.g. Plaid). */
  pending?: boolean;
  /** The user chose the category by hand; rules never change it. */
  categoryEdited?: boolean;
  /** The user renamed the merchant by hand; rules never rename it. */
  merchantEdited?: boolean;
  /** Id of the CSV import that added this transaction (see {@link ImportBatch}); absent for any other source. */
  importBatchId?: string;
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

/**
 * Auto-categorisation rule. Every condition that is set must match. Rules are kept in
 * priority order: the first matching rule wins. Text conditions are case-insensitive;
 * merchant conditions match either the merchant or the provider's description, so a rule
 * keeps matching after a merchant is renamed.
 */
export interface Rule {
  id: string;
  /** Exact merchant match. */
  merchant?: string;
  /** Substring of the merchant. */
  merchantContains?: string;
  /** Regular expression tested against the merchant. */
  merchantRegex?: string;
  /** Substring of the description. */
  descriptionContains?: string;
  /** Regular expression tested against the description. */
  descriptionRegex?: string;
  /** Exact amount (signed, same convention as Transaction.amount). */
  amountEquals?: number;
  /** Inclusive amount bounds (signed, same convention as Transaction.amount). */
  amountMin?: number;
  amountMax?: number;
  /** Only transactions in this account. */
  accountId?: string;
  categoryId: string;
  /** Also rename the merchant to this. */
  renameMerchant?: string;
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
  /**
   * Decimal separator of the amounts; the other one separates thousands ("1,234.56" or
   * "1.234,56"). When unset it is detected from the file's amounts.
   */
  decimal?: DecimalSeparator;
  /** Order of month, day and year in numeric dates. When unset it is detected from the file's dates. */
  dateOrder?: DateOrder;
  /** Character that separates the file's cells. When unset it is detected from the file's first lines. */
  delimiter?: CsvDelimiter;
}

export type DecimalSeparator = '.' | ',';

/** Comma, semicolon or tab. */
export type CsvDelimiter = ',' | ';' | '\t';

/** Month first (12/31/2026), day first (31/12/2026) or year first (2026-12-31). */
export type DateOrder = 'MDY' | 'DMY' | 'YMD';

/** How often a recurring charge repeats. */
export type Cadence = 'weekly' | 'monthly' | 'yearly';

/** What the user decided about a detected recurring series. */
export type RecurringDecision = 'confirmed' | 'dismissed';

/** A recurring charge the user added by hand. */
export interface ManualRecurring {
  id: string;
  name: string;
  /** Signed, same convention as Transaction.amount (negative = a charge). */
  amount: number;
  cadence: Cadence;
  /** YYYY-MM-DD: a date the charge is due; later due dates follow from the cadence. */
  nextDate: string;
}

/** The user's recurring choices; detected series themselves are recomputed from transactions. */
export interface RecurringSettings {
  /** Decisions on detected series, keyed by series key (see `lib/recurring`). */
  decisions: Record<string, RecurringDecision>;
  manual: ManualRecurring[];
}

/** A balance snapshot an import wrote, with the one it replaced, so undoing the import can put it back. */
export interface ImportSnapshot {
  accountId: string;
  /** ISO date, YYYY-MM-DD */
  date: string;
  /** The balance the import wrote. */
  balance: number;
  /** The snapshot it replaced; absent when there was none. */
  before?: BalanceSnapshot;
}

/** One CSV import, recorded so it can be undone. */
export interface ImportBatch {
  id: string;
  /** Name of the imported file. */
  file: string;
  /** Account the rows were imported into. */
  accountId: string;
  /** Rows in the file. */
  rows: number;
  /** Transactions the import added; only these carry the batch's id. */
  added: number;
  /** ISO timestamp of the import. */
  at: string;
  /** The import created the account. */
  newAccount?: boolean;
  /** Ids of categories the import created (from the file's category column). */
  categories?: string[];
  /** Balance snapshots the import wrote. */
  snapshots?: ImportSnapshot[];
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
  /** Confirmed / dismissed detected series and manually added ones. Absent until the user makes a choice. */
  recurring?: RecurringSettings;
  /** Currency, budget month start and theme. Absent until changed; see `settingsOf` for defaults. */
  settings?: Settings;
  /** CSV imports that can be undone, newest first. Absent until the first one. */
  importBatches?: ImportBatch[];
}

export const CATEGORIES = [
  'Groceries', 'Dining', 'Transport', 'Shopping', 'Utilities', 'Rent',
  'Entertainment', 'Health', 'Travel', 'Income', 'Transfer', 'Other',
] as const;

/** Categories that never count as spending. */
export const NON_SPEND = new Set(['Income', 'Transfer']);
