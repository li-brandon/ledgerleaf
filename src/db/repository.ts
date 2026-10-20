import type { Account, BalanceSnapshot, Budget, Category, Rule, Transaction } from '../lib/types';

/** Snapshots have no id; they are keyed by account and day. */
export type SnapshotKey = [accountId: string, date: string];

/** One record type per object store, with the type of its primary key. */
export interface Models {
  accounts: { value: Account; key: string };
  transactions: { value: Transaction; key: string };
  categories: { value: Category; key: string };
  rules: { value: Rule; key: string };
  budgets: { value: Budget; key: string };
  balanceSnapshots: { value: BalanceSnapshot; key: SnapshotKey };
}

export type ModelName = keyof Models;
export const MODEL_NAMES: readonly ModelName[] = [
  'accounts', 'transactions', 'categories', 'rules', 'budgets', 'balanceSnapshots',
];

export const keyOf: { [K in ModelName]: (v: Models[K]['value']) => Models[K]['key'] } = {
  accounts: (a) => a.id,
  transactions: (t) => t.id,
  categories: (c) => c.id,
  rules: (r) => r.id,
  budgets: (b) => b.id,
  balanceSnapshots: (s) => [s.accountId, s.date],
};

/** Small key/value data that is not a list of records. */
export interface Meta {
  /** Schema version of the stored records; absent means the database has never been written. */
  version?: number;
  lastSync?: string;
  /**
   * Record keys (see {@link recordId}) of each store in ledger order. Stores return records
   * in key order, but order is meaningful (newest-first transactions, rule precedence).
   */
  order?: Partial<Record<ModelName, string[]>>;
}

/** A store key as a string, so compound keys can be compared and listed. */
export const recordId = <K extends ModelName>(name: K, v: Models[K]['value']) =>
  JSON.stringify((keyOf[name] as (v: Models[K]['value']) => Models[K]['key'])(v));

export type LedgerRecords = { [K in ModelName]: Models[K]['value'][] };

/** A batch of writes applied atomically by {@link Repository.apply}. */
export interface LedgerChanges {
  /** Empty every store (including meta) before applying the rest. */
  clear?: boolean;
  put?: Partial<LedgerRecords>;
  delete?: { [K in ModelName]?: Models[K]['key'][] };
  /** Replaces the whole meta record when present. */
  meta?: Meta;
}

export interface EntityStore<T, K> {
  get(key: K): Promise<T | undefined>;
  getAll(): Promise<T[]>;
  put(value: T): Promise<void>;
  putMany(values: T[]): Promise<void>;
  delete(key: K): Promise<void>;
  clear(): Promise<void>;
  count(): Promise<number>;
}

export interface TransactionStore extends EntityStore<Transaction, string> {
  /** Transactions dated within [from, to] (inclusive ISO dates), oldest first. */
  byDate(from: string, to: string): Promise<Transaction[]>;
  byAccount(accountId: string): Promise<Transaction[]>;
}

export interface MetaStore {
  get(): Promise<Meta>;
  set(meta: Meta): Promise<void>;
}

/** Storage-agnostic access to the ledger. Implementations never touch the network. */
export interface Repository {
  accounts: EntityStore<Account, string>;
  transactions: TransactionStore;
  categories: EntityStore<Category, string>;
  rules: EntityStore<Rule, string>;
  budgets: EntityStore<Budget, string>;
  balanceSnapshots: EntityStore<BalanceSnapshot, SnapshotKey>;
  meta: MetaStore;
  /** Every record plus meta, read in one transaction. */
  readAll(): Promise<{ records: LedgerRecords; meta: Meta }>;
  /** Apply a batch of writes in one transaction: all of it lands or none of it does. */
  apply(changes: LedgerChanges): Promise<void>;
  close(): void;
}
