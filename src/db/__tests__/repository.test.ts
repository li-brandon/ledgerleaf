import { describe, expect, it } from 'vitest';
import type { EntityStore, Repository } from '../repository';
import type { Account, BalanceSnapshot, Budget, Category, Rule, Transaction } from '../../lib/types';
import { ADAPTERS, makeTransactions } from './helpers';

interface Case<T, K> {
  pick: (r: Repository) => EntityStore<T, K>;
  a: T;
  b: T;
  key: (v: T) => K;
  edit: (v: T) => T;
}

const account: Case<Account, string> = {
  pick: (r) => r.accounts,
  a: { id: 'acc-1', name: 'Checking', type: 'checking', currency: 'USD', hidden: false },
  b: { id: 'acc-2', name: 'Visa', type: 'credit', balance: -120.5 },
  key: (v) => v.id,
  edit: (v) => ({ ...v, name: 'Renamed' }),
};
const [tx1, tx2] = makeTransactions(2);
const transaction: Case<Transaction, string> = {
  pick: (r) => r.transactions, a: tx1, b: tx2, key: (v) => v.id, edit: (v) => ({ ...v, notes: 'edited' }),
};
const category: Case<Category, string> = {
  pick: (r) => r.categories,
  a: { id: 'coffee', name: 'Coffee', group: 'Custom', color: '#000', icon: '☕', excludeFromSpend: false },
  b: { id: 'pets', name: 'Pets', group: 'Custom', color: '#111', icon: '🐶', excludeFromSpend: false },
  key: (v) => v.id,
  edit: (v) => ({ ...v, color: '#fff' }),
};
const rule: Case<Rule, string> = {
  pick: (r) => r.rules,
  a: { id: 'r1', merchant: 'Bean There', categoryId: 'coffee' },
  b: { id: 'r2', descriptionContains: 'vet', amountMax: 0, categoryId: 'pets' },
  key: (v) => v.id,
  edit: (v) => ({ ...v, categoryId: 'dining' }),
};
const budget: Case<Budget, string> = {
  pick: (r) => r.budgets,
  a: { id: 'groceries:2026-10', categoryId: 'groceries', month: '2026-10', amount: 400, rollover: false },
  b: { id: 'dining:2026-10', categoryId: 'dining', month: '2026-10', amount: 150, rollover: true },
  key: (v) => v.id,
  edit: (v) => ({ ...v, amount: 999 }),
};
const snapshot: Case<BalanceSnapshot, [string, string]> = {
  pick: (r) => r.balanceSnapshots,
  a: { accountId: 'acc-1', date: '2026-10-01', balance: 100 },
  b: { accountId: 'acc-1', date: '2026-10-02', balance: 90 },
  key: (v) => [v.accountId, v.date],
  edit: (v) => ({ ...v, balance: 42 }),
};

const MODELS = { account, transaction, category, rule, budget, snapshot } as Record<string, Case<unknown, unknown>>;

describe.each(ADAPTERS)('%s repository', (_, open) => {
  describe.each(Object.entries(MODELS))('%s CRUD', (_, c) => {
    it('creates, reads, updates and deletes', async () => {
      const store = c.pick(await open());
      expect(await store.getAll()).toEqual([]);

      await store.put(c.a);
      await store.putMany([c.b]);
      expect(await store.count()).toBe(2);
      expect(await store.get(c.key(c.a))).toEqual(c.a);
      expect(await store.get(c.key(c.edit(c.a)) as never)).toEqual(c.a);

      await store.put(c.edit(c.a));
      expect(await store.get(c.key(c.a))).toEqual(c.edit(c.a));
      expect(await store.count()).toBe(2);

      await store.delete(c.key(c.a));
      expect(await store.get(c.key(c.a))).toBeUndefined();
      expect(await store.getAll()).toEqual([c.b]);

      await store.clear();
      expect(await store.count()).toBe(0);
    });

    it('does not share references with the caller', async () => {
      const store = c.pick(await open());
      const value = structuredClone(c.a) as Record<string, unknown>;
      await store.put(value);
      value.mutated = true;
      expect(await store.get(c.key(c.a))).toEqual(c.a);
    });
  });

  it('reads and replaces meta', async () => {
    const repo = await open();
    expect(await repo.meta.get()).toEqual({});
    await repo.meta.set({ version: 2, lastSync: '2026-10-20T00:00:00.000Z' });
    expect(await repo.meta.get()).toEqual({ version: 2, lastSync: '2026-10-20T00:00:00.000Z' });
    await repo.meta.set({ version: 2 });
    expect(await repo.meta.get()).toEqual({ version: 2 });
  });

  it('queries transactions by date range and account', async () => {
    const repo = await open();
    const txns = makeTransactions(60);
    await repo.transactions.putMany(txns);

    const march = await repo.transactions.byDate('2026-03-01', '2026-03-31');
    expect(march.map((t) => t.id).sort()).toEqual(txns.filter((t) => t.date.startsWith('2026-03')).map((t) => t.id).sort());
    expect(march.map((t) => t.date)).toEqual([...march.map((t) => t.date)].sort());

    const acc2 = await repo.transactions.byAccount('acc-2');
    expect(acc2).toHaveLength(txns.filter((t) => t.accountId === 'acc-2').length);
    expect(acc2.every((t) => t.accountId === 'acc-2')).toBe(true);
  });

  it('applies a batch of puts, deletes and meta across stores', async () => {
    const repo = await open();
    await repo.apply({ put: { accounts: [account.a, account.b], rules: [rule.a] }, meta: { version: 2 } });
    await repo.apply({
      put: { transactions: [tx1], balanceSnapshots: [snapshot.a] },
      delete: { accounts: ['acc-2'], rules: ['r1'] },
      meta: { version: 2, lastSync: 'now' },
    });
    const { records, meta } = await repo.readAll();
    expect(records.accounts).toEqual([account.a]);
    expect(records.rules).toEqual([]);
    expect(records.transactions).toEqual([tx1]);
    expect(records.balanceSnapshots).toEqual([snapshot.a]);
    expect(meta).toEqual({ version: 2, lastSync: 'now' });
  });

  it('clear empties every store before applying the batch', async () => {
    const repo = await open();
    await repo.apply({ put: { accounts: [account.a], budgets: [budget.a] }, meta: { version: 2, lastSync: 'x' } });
    await repo.apply({ clear: true, put: { budgets: [budget.b] } });
    const { records, meta } = await repo.readAll();
    expect(records.accounts).toEqual([]);
    expect(records.budgets).toEqual([budget.b]);
    expect(meta).toEqual({});
  });

  it('rolls back the whole batch when one write fails', async () => {
    const repo = await open();
    await repo.apply({ put: { accounts: [account.a] }, meta: { version: 2 } });
    const bad = { id: 'bad', fn: () => 1 } as unknown as Account; // functions cannot be cloned
    await expect(repo.apply({ put: { accounts: [account.b, bad] }, delete: { accounts: ['acc-1'] } })).rejects.toThrow();
    expect((await repo.readAll()).records.accounts).toEqual([account.a]);
  });
});
