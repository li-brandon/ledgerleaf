import {
  MODEL_NAMES, keyOf, type EntityStore, type LedgerChanges, type LedgerRecords, type Meta, type ModelName,
  type Models, type Repository, type TransactionStore,
} from './repository';
import type { Transaction } from '../lib/types';

type Tables = { [K in ModelName]: Map<string, Models[K]['value']> };

/** Map keys must be primitives, so compound keys are serialised. */
const mapKey = (k: Models[ModelName]['key']) => (typeof k === 'string' ? k : JSON.stringify(k));
const byDateAsc = (a: Transaction, b: Transaction) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

/** IndexedDB stores meta as one entry per key, so undefined values are simply absent. */
const cleanMeta = (m: Meta): Meta =>
  structuredClone(Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)));

const emptyTables = (): Tables => ({
  accounts: new Map(), transactions: new Map(), categories: new Map(),
  rules: new Map(), budgets: new Map(), balanceSnapshots: new Map(),
});

/**
 * Repository backed by plain Maps; used by tests and as a fallback when IndexedDB is
 * unavailable. Values are cloned on the way in and out, like IndexedDB.
 */
export function createMemoryRepository(): Repository {
  let tables = emptyTables();
  let meta: Meta = {};

  function store<K extends ModelName>(name: K): EntityStore<Models[K]['value'], Models[K]['key']> {
    const table = () => tables[name] as Map<string, Models[K]['value']>;
    const put = (v: Models[K]['value']) => { table().set(mapKey(keyOf[name](v)), structuredClone(v)); };
    return {
      get: async (k) => structuredClone(table().get(mapKey(k))),
      getAll: async () => structuredClone([...table().values()]),
      put: async (v) => put(v),
      putMany: async (vs) => vs.forEach(put),
      delete: async (k) => { table().delete(mapKey(k)); },
      clear: async () => table().clear(),
      count: async () => table().size,
    };
  }

  const txStore = store('transactions');
  const transactions: TransactionStore = {
    ...txStore,
    byDate: async (from, to) =>
      (await txStore.getAll()).filter((t) => t.date >= from && t.date <= to).sort(byDateAsc),
    byAccount: async (accountId) => (await txStore.getAll()).filter((t) => t.accountId === accountId),
  };

  return {
    accounts: store('accounts'),
    transactions,
    categories: store('categories'),
    rules: store('rules'),
    budgets: store('budgets'),
    balanceSnapshots: store('balanceSnapshots'),
    meta: {
      get: async () => structuredClone(meta),
      set: async (m) => { meta = cleanMeta(m); },
    },
    async readAll() {
      const records = Object.fromEntries(
        MODEL_NAMES.map((n) => [n, structuredClone([...tables[n].values()])]),
      ) as unknown as LedgerRecords;
      return { records, meta: structuredClone(meta) };
    },
    async apply(changes: LedgerChanges) {
      // Work on copies and swap at the end so a throw leaves the data untouched.
      const next = emptyTables();
      for (const name of MODEL_NAMES) {
        const table = next[name] as Map<string, unknown>;
        const key = keyOf[name] as (v: unknown) => Models[ModelName]['key'];
        if (!changes.clear) for (const [k, v] of tables[name]) table.set(k, v);
        for (const k of changes.delete?.[name] ?? []) table.delete(mapKey(k));
        for (const v of changes.put?.[name] ?? []) table.set(mapKey(key(v)), structuredClone(v));
      }
      meta = changes.meta ? cleanMeta(changes.meta) : changes.clear ? {} : meta;
      tables = next;
    },
    close() {},
  };
}
