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

/** Open (creating or upgrading if needed) the ledger database and wrap it as a Repository. */
export async function openIdbRepository(name = DB_NAME): Promise<Repository> {
  const db = await openDB<LedgerDB>(name, DB_VERSION, {
    upgrade(db) {
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
      async set(meta) {
        const tx = db.transaction('meta', 'readwrite');
        await commit(tx, (ops) => ops.push(tx.store.clear(), ...writeMeta(tx.store, meta)));
      },
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
        if (changes.meta) {
          const os = tx.objectStore('meta');
          ops.push(os.clear(), ...writeMeta(os, changes.meta));
        }
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

function writeMeta(os: { put(value: never, key: never): Promise<unknown> }, meta: Meta) {
  return Object.entries(meta).filter(([, v]) => v !== undefined).map(([k, v]) => os.put(v as never, k as never));
}
