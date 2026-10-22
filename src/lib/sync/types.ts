import type { Account, Transaction } from '../types';

/** Where a provider's data comes from: a user-supplied file, built-in sample data, or a remote service. */
export type ProviderKind = 'file' | 'demo' | 'remote';

/** Static description of a provider, enough to list it before anything is fetched. */
export interface ProviderMeta {
  /** Stable id, also stamped on every transaction as `source`. */
  id: string;
  name: string;
  kind: ProviderKind;
  /** Whether the provider needs the user to sign in before it can sync. */
  requiresAuth: boolean;
  description?: string;
}

/** A provider-reported balance for one account. */
export interface AccountBalance {
  accountId: string;
  balance: number;
  /** ISO date, YYYY-MM-DD; defaults to the day of the sync. */
  date?: string;
}

/**
 * A pluggable data source. Everything is read-only: providers report what they hold and
 * `applySync` decides what to merge into the ledger.
 */
export interface SyncProvider extends ProviderMeta {
  listAccounts(): Promise<Account[]>;
  /** Transactions dated on or after `since` (ISO date, inclusive), or all of them without it. */
  fetchTransactions(since?: string): Promise<Transaction[]>;
  fetchBalances?(): Promise<AccountBalance[]>;
  /** Transactions the provider has deleted since the last sync (incremental providers, e.g. Plaid). */
  fetchRemovals?(): Promise<RemovedTransaction[]>;
  /** Input rows that could not be read (file providers), known once data has been fetched. */
  readonly skipped?: number;
}

/** A transaction the provider no longer has, identified by its own id. */
export interface RemovedTransaction {
  externalId: string;
  /** Set by `fetchSync` to the provider id. */
  source?: string;
}

/**
 * A provider backed by a remote service (e.g. a bank aggregator). The only one is
 * `PlaidProvider`, which talks to the localhost Plaid server, never to Plaid directly.
 */
export interface RemoteSyncProvider extends SyncProvider {
  kind: 'remote';
  requiresAuth: true;
  /** Whether the user has an active session with the remote service. */
  isAuthenticated(): Promise<boolean>;
}

/** Everything one provider returned for a single sync. */
export interface SyncResult {
  accounts: Account[];
  transactions: Transaction[];
  balances?: AccountBalance[];
  /** Transactions to delete from the ledger. */
  removed?: RemovedTransaction[];
}
