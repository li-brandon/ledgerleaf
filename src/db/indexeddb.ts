import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  MODEL_NAMES, type EntityStore, type LedgerChanges, type LedgerRecords, type Meta, type ModelName, type Models,
  type Repository,
} from './repository';
import type { Account, BalanceSnapshot, Budget, Category, Rule, Transaction } from '../lib/types';

export const DB_NAME = 'ledgerleaf';
export const DB_VERSION = 1;

interface LedgerDB extends DBSchema {
  accounts: { key: string; value: Account };
  transactions: { key: string; value: Transaction; indexes: { date: string; accountId: string } };
  categories: { key: string; value: Category };
  rules: { key: string; value: Rule };
  budgets: { key: string; value: Budget };
  balanceSnapshots: { key: [string, string]; value: BalanceSnapshot };
  meta: { key: keyof Meta; value: Meta[keyof Meta] };
}

const STORES = [...MODEL_NAMES, 'meta'] as const;

export interface OpenOptions {
  /** Tests open at a newer version to exercise upgrades. */
  version?: number;
  /** An older tab holds the database open, so this tab's upgrade waits until it closes. */
  onBlocked?(): void;
  /**
   * Another tab wants to upgrade the database. This connection closes once the returned
   * promise settles (e.g. after a last save); writes after that reject.
   */
  onBlocking?(): unknown;
}

/** Open (creating or upgrading if needed) the ledger database and wrap it as a Repository. */
export async function openIdbRepository(name = DB_NAME, options: OpenOptions = {}): Promise<Repository> {
  const db = await openDB<LedgerDB>(name, options.version ?? DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion >= 1) return;
      db.createObjectStore('accounts', { keyPath: 'id' });
      const tx = db.createObjectStore('transactions', { keyPath: 'id' });
      tx.createIndex('date', 'date');
      tx.createIndex('accountId', 'accountId');
      db.createObjectStore('categories', { keyPath: 'id' });
      db.createObjectStore('rules', { keyPath: 'id' });
      db.createObjectStore('budgets', { keyPath: 'id' });
      db.createObjectStore('balanceSnapshots', { keyPath: ['accountId', 'date'] });
      db.createObjectStore('meta');
    },
    blocked: () => options.onBlocked?.(),
    blocking: () => void Promise.resolve().then(() => options.onBlocking?.()).finally(() => db.close()),
  });
  return idbRepository(db);
}

function idbRepository(db: IDBPDatabase<LedgerDB>): Repository {
  // idb's per-store generics don't distribute over a union of store names, so the
  // generic helpers below go through this loosely typed view of the same database.
  const raw = db as unknown as IDBPDatabase;

  function store<K extends ModelName>(name: K): EntityStore<Models[K]['value'], Models[K]['key']> {
    return {
      get: (k) => raw.get(name, k),
      getAll: () => raw.getAll(name),
      put: async (v) => { await raw.put(name, v); },
      putMany: async (vs) => {
        const tx = raw.transaction(name, 'readwrite');
        await commit(tx, (ops) => { for (const v of vs) ops.push(tx.store.put(v)); });
      },
      delete: (k) => raw.delete(name, k),
      clear: () => raw.clear(name),
      count: () => raw.count(name),
    };
  }

  async function readMeta(os = db.transaction('meta').store): Promise<Meta> {
    const [keys, values] = await Promise.all([os.getAllKeys(), os.getAll()]);
    return Object.fromEntries(keys.map((k, i) => [k, values[i]])) as Meta;
  }

  return {
    accounts: store('accounts'),
    transactions: {
      ...store('transactions'),
      byDate: (from, to) => db.getAllFromIndex('transactions', 'date', IDBKeyRange.bound(from, to)),
      byAccount: (accountId) => db.getAllFromIndex('transactions', 'accountId', accountId),
    },
    categories: store('categories'),
    rules: store('rules'),
    budgets: store('budgets'),
    balanceSnapshots: store('balanceSnapshots'),
    meta: {
      get: () => readMeta(),
    },

    async readAll() {
      const tx = raw.transaction(STORES, 'readonly');
      const [lists, meta] = await Promise.all([
        Promise.all(MODEL_NAMES.map((n) => tx.objectStore(n).getAll())),
        readMeta(tx.objectStore('meta') as never),
      ]);
      await tx.done;
      const records = Object.fromEntries(MODEL_NAMES.map((n, i) => [n, lists[i]])) as unknown as LedgerRecords;
      return { records, meta };
    },

    async apply(changes: LedgerChanges, options) {
      const tx = raw.transaction(STORES, 'readwrite');
      // Awaiting a request of the same transaction keeps it open, so check-then-write is atomic.
      if (options?.ifEmpty && (await tx.objectStore('meta').get('version')) !== undefined) {
        await tx.done;
        return false;
      }
      await commit(tx, (ops) => {
        if (changes.clear) for (const n of STORES) ops.push(tx.objectStore(n).clear());
        for (const n of MODEL_NAMES) {
          const os = tx.objectStore(n);
          for (const k of changes.delete?.[n] ?? []) ops.push(os.delete(k));
          for (const v of changes.put?.[n] ?? []) ops.push(os.put(v));
        }
        const os = tx.objectStore('meta');
        for (const [k, v] of Object.entries(changes.meta ?? {})) ops.push(v === undefined ? os.delete(k) : os.put(v, k));
      });
      return true;
    },

    close: () => db.close(),
  };
}

/**
 * Queue requests on `tx` without awaiting each one (IndexedDB runs them in order) and wait
 * for the commit. A failed request aborts the whole transaction. Some errors, such as
 * DataCloneError, throw synchronously instead, which would let the requests queued so far
 * commit; abort explicitly in that case so nothing partial lands.
 */
async function commit(tx: { abort(): void; done: Promise<void> }, queue: (ops: Promise<unknown>[]) => void) {
  const ops: Promise<unknown>[] = [];
  try {
    queue(ops);
  } catch (e) {
    tx.abort();
    await Promise.allSettled([...ops, tx.done]);
    throw e;
  }
  await Promise.all([...ops, tx.done]);
}
