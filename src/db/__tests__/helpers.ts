import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openIdbRepository } from '../indexeddb';
import { createMemoryRepository } from '../memory';
import type { Repository } from '../repository';
import type { LegacyStorage } from '../ledger';
import type { Transaction } from '../../lib/types';

/** Each call gets a brand-new fake IndexedDB, so tests never share data. */
async function freshIdb(): Promise<Repository> {
  globalThis.indexedDB = new IDBFactory();
  return openIdbRepository();
}

export const ADAPTERS: [string, () => Promise<Repository>][] = [
  ['memory', async () => createMemoryRepository()],
  ['indexeddb', freshIdb],
];

export function memoryStorage(init: Record<string, string> = {}): LegacyStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    removeItem: (k) => { data.delete(k); },
  };
}

export function makeTransactions(n: number, accountId = 'acc-1'): Transaction[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `tx-${i}`,
    date: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    description: `Merchant ${i % 50}`,
    amount: -((i % 200) + 0.99),
    category: 'Groceries',
    categoryId: 'groceries',
    accountId: i % 3 ? accountId : 'acc-2',
    merchant: `Merchant ${i % 50}`,
    reviewed: false,
  }));
}
