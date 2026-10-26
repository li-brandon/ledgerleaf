import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diffLedger, loadLedger, readLedger, saveLedger } from '../ledger';
import { createPersister, type SaveStatus } from '../persister';
import { V1_KEY, V2_KEY, emptyLedger, migrate, type LedgerStateV1 } from '../../lib/migrate';
import { applySync } from '../../lib/sync';
import { addMerchantRule, editTransaction, setReviewed } from '../../lib/txEdits';
import type { LedgerState } from '../../lib/types';
import { ADAPTERS, makeTransactions, memoryStorage } from './helpers';

const MONTH = '2026-10';

const v1: LedgerStateV1 = {
  accounts: [{ id: 'acc-1', name: 'Checking', type: 'checking' }],
  transactions: [
    { id: 'mock-1', date: '2026-10-02', description: 'Green Basket', amount: -80, category: 'Groceries', accountId: 'acc-1' },
    { id: 'csv-2', date: '2026-10-03', description: 'Bean There', amount: -4.5, category: 'Coffee Shops', accountId: 'acc-1' },
  ],
  budgets: { Groceries: 400 },
  lastSync: '2026-10-19T12:00:00.000Z',
};

function sample(): LedgerState {
  return {
    ...emptyLedger(MONTH),
    accounts: [{ id: 'acc-1', name: 'Checking', type: 'checking', currency: 'USD', hidden: false }],
    transactions: makeTransactions(10),
    rules: [{ id: 'r1', merchant: 'Merchant 1', categoryId: 'dining' }],
    balanceSnapshots: [{ accountId: 'acc-1', date: '2026-10-01', balance: 10 }],
    lastSync: '2026-10-20T08:00:00.000Z',
  };
}

describe('diffLedger', () => {
  it('replaces everything without a previous state', () => {
    const s = sample();
    const d = diffLedger(s);
    expect(d.clear).toBe(true);
    expect(d.put?.transactions).toBe(s.transactions);
    expect(d.meta).toMatchObject({ version: 2, lastSync: s.lastSync });
    expect(d.meta?.order?.transactions).toEqual(s.transactions.map((t) => JSON.stringify(t.id)));
    expect(d.meta?.order?.balanceSnapshots).toEqual([JSON.stringify(['acc-1', '2026-10-01'])]);
  });

  it('puts only changed records and deletes removed ones', () => {
    const prev = sample();
    const [first, second, ...rest] = prev.transactions;
    const edited = { ...second, notes: 'hi' };
    const next = { ...prev, transactions: [edited, ...rest], balanceSnapshots: [] };
    const d = diffLedger(next, prev);
    expect(d.clear).toBeUndefined();
    expect(d.put).toEqual({ transactions: [edited] });
    expect(d.delete).toEqual({ transactions: [first.id], balanceSnapshots: [['acc-1', '2026-10-01']] });
  });

  it('writes nothing but the version when nothing changed', () => {
    const s = sample();
    expect(diffLedger(s, s)).toEqual({ put: {}, delete: {}, meta: { version: 2 } });
    // A rebuilt store in the same order leaves the order alone.
    expect(diffLedger({ ...s, transactions: [...s.transactions] }, s).meta).toEqual({ version: 2 });
  });

  it('writes only the meta keys that changed, and undefined to delete one', () => {
    const prev = sample();
    const next = { ...prev, settings: { currency: 'EUR', monthStartDay: 1, theme: 'dark' as const }, lastSync: undefined };
    const d = diffLedger(next, prev);
    expect(d.meta).toEqual({ version: 2, settings: next.settings, lastSync: undefined });
    expect(d.meta).toHaveProperty('lastSync');

    const reordered = { ...prev, rules: [...prev.rules, { id: 'r2', merchant: 'x', categoryId: 'dining' }] };
    expect(diffLedger(reordered, prev).meta).toEqual({ version: 2, order: expect.objectContaining({ rules: ['"r1"', '"r2"'] }) });
  });
});

describe.each(ADAPTERS)('ledger on %s', (_, open) => {
  it('round-trips a ledger through saveLedger and readLedger', async () => {
    const repo = await open();
    expect(await readLedger(repo)).toBeUndefined();
    const s = sample();
    await saveLedger(repo, s);
    expect(await readLedger(repo)).toEqual(migrate(s));
  });

  it('persists import batches and the batch id of each transaction, and their removal', async () => {
    const repo = await open();
    const prev = sample();
    await saveLedger(repo, prev);
    const batch = {
      id: 'imp-1', file: 'bank.csv', accountId: 'acc-1', rows: 3, added: 2, at: '2026-10-20T08:00:00.000Z',
      snapshots: [{ accountId: 'acc-1', date: '2026-10-20', balance: 5, before: { accountId: 'acc-1', date: '2026-10-20', balance: 4 } }],
    };
    const next: LedgerState = {
      ...prev,
      transactions: prev.transactions.map((t, i) => (i < 2 ? { ...t, importBatchId: 'imp-1' } : t)),
      importBatches: [batch],
    };
    await saveLedger(repo, next, prev);
    const loaded = (await readLedger(repo))!;
    expect(loaded.importBatches).toEqual([batch]);
    expect(loaded.transactions.filter((t) => t.importBatchId === 'imp-1').map((t) => t.id)).toEqual([next.transactions[0].id, next.transactions[1].id]);

    await saveLedger(repo, { ...next, importBatches: undefined }, next);
    expect((await readLedger(repo))!.importBatches).toBeUndefined();
    expect(await repo.meta.get()).not.toHaveProperty('importBatches');
  });

  it('applies incremental saves', async () => {
    const repo = await open();
    const prev = sample();
    await saveLedger(repo, prev);
    const next: LedgerState = {
      ...prev,
      transactions: prev.transactions.slice(1).map((t, i) => (i === 0 ? { ...t, reviewed: true } : t)),
      rules: [],
      lastSync: undefined,
    };
    await saveLedger(repo, next, prev);
    const loaded = await readLedger(repo);
    expect(loaded?.transactions).toHaveLength(9);
    expect(loaded?.transactions.find((t) => t.id === next.transactions[0].id)?.reviewed).toBe(true);
    expect(loaded?.rules).toEqual([]);
    expect(loaded?.lastSync).toBeUndefined();
    expect(await repo.meta.get()).not.toHaveProperty('lastSync');
  });

  it('persists transaction edits and rules, which then survive a re-sync', async () => {
    const repo = await open();
    const prev = sample();
    await saveLedger(repo, prev);
    const [a, b] = prev.transactions;
    let next = editTransaction(prev, a.id, { merchant: 'Corner Shop', notes: 'milk', reviewed: true });
    next = addMerchantRule(next, b.id, 'Health');
    next = setReviewed(next, [b.id], true);
    await saveLedger(repo, next, prev);

    const loaded = (await readLedger(repo))!;
    expect(loaded.transactions.find((t) => t.id === a.id)).toMatchObject({ merchant: 'Corner Shop', notes: 'milk', reviewed: true });
    expect(loaded.transactions.find((t) => t.id === b.id)).toMatchObject({ categoryId: 'health', reviewed: true });
    expect(loaded.rules[0]).toMatchObject({ merchant: b.description, categoryId: 'health' });

    const incoming = { accounts: [], transactions: [a, b].map((t) => ({ ...t, merchant: undefined, notes: undefined, reviewed: false })) };
    const { state } = applySync(loaded, 'bank', incoming, new Date(2026, 9, 21));
    expect(state.transactions.find((t) => t.id === a.id)).toMatchObject({ merchant: 'Corner Shop', notes: 'milk', reviewed: true });
    expect(state.transactions.find((t) => t.id === b.id)).toMatchObject({ categoryId: 'health', reviewed: true });
  });

  it('preserves record order, which the stores do not', async () => {
    const repo = await open();
    const prev = sample();
    const reversed = { ...prev, transactions: [...prev.transactions].reverse(), categories: [...prev.categories].reverse() };
    await saveLedger(repo, reversed);
    expect((await readLedger(repo))?.transactions).toEqual(reversed.transactions);

    const appended = { ...reversed, rules: [...reversed.rules, { id: 'a0', merchant: 'x', categoryId: 'dining' }] };
    await saveLedger(repo, appended, reversed);
    const loaded = await readLedger(repo);
    expect(loaded?.rules.map((r) => r.id)).toEqual(['r1', 'a0']);
    expect(loaded?.categories.map((c) => c.id)).toEqual(reversed.categories.map((c) => c.id));
  });

  it('starts empty and persists the fresh ledger when nothing exists anywhere', async () => {
    const repo = await open();
    const storage = memoryStorage();
    const s = await loadLedger(repo, storage);
    expect(s.transactions).toEqual([]);
    expect(s.categories.length).toBeGreaterThan(0);
    expect(await readLedger(repo)).toEqual(s);
  });

  it.each([
    ['v1', V1_KEY, v1],
    ['v2', V2_KEY, migrate(v1, MONTH)],
  ])('migrates a %s localStorage save once and removes the keys', async (_, key, saved) => {
    const repo = await open();
    const storage = memoryStorage({ [key]: JSON.stringify(saved) });
    const s = await loadLedger(repo, storage);

    expect(s.accounts.map((a) => a.id)).toEqual(['acc-1']);
    expect(s.transactions.map((t) => t.categoryId)).toEqual(['groceries', 'coffee-shops']);
    expect(s.lastSync).toBe(v1.lastSync);
    expect(s.budgets.find((b) => b.categoryId === 'groceries')?.amount).toBe(400);
    expect(storage.data.size).toBe(0);
    expect(await readLedger(repo)).toEqual(s);
  });

  it('prefers the v2 key and removes both legacy keys', async () => {
    const repo = await open();
    const v2 = { ...migrate(v1, MONTH), accounts: [] };
    const storage = memoryStorage({ [V1_KEY]: JSON.stringify(v1), [V2_KEY]: JSON.stringify(v2) });
    expect((await loadLedger(repo, storage)).accounts).toEqual([]);
    expect(storage.data.size).toBe(0);
  });

  it('ignores localStorage once the database has data', async () => {
    const repo = await open();
    await saveLedger(repo, sample());
    const storage = memoryStorage({ [V1_KEY]: JSON.stringify(v1) });
    const s = await loadLedger(repo, storage);
    expect(s.transactions).toHaveLength(10);
    expect(storage.data.has(V1_KEY)).toBe(true);
  });

  it('does not overwrite a ledger written by a concurrent first load', async () => {
    const repo = await open();
    const storage = memoryStorage({ [V1_KEY]: JSON.stringify(v1) });
    const [a, b] = await Promise.all([loadLedger(repo, storage), loadLedger(repo, memoryStorage())]);
    expect(a).toEqual(b);
    expect(await readLedger(repo)).toEqual(a);
  });

  it('leaves an unreadable localStorage save in place', async () => {
    const repo = await open();
    const storage = memoryStorage({ [V2_KEY]: '{not json' });
    expect((await loadLedger(repo, storage)).transactions).toEqual([]);
    expect(storage.data.get(V2_KEY)).toBe('{not json');
  });

  it('keeps the localStorage keys if writing the migration fails', async () => {
    const repo = await open();
    vi.spyOn(repo, 'apply').mockRejectedValueOnce(new Error('quota'));
    const storage = memoryStorage({ [V1_KEY]: JSON.stringify(v1) });
    await expect(loadLedger(repo, storage)).rejects.toThrow('quota');
    expect(storage.data.has(V1_KEY)).toBe(true);
  });
});

describe('createPersister', () => {
  it('debounces and writes only the latest state, diffed against the last save', async () => {
    vi.useFakeTimers();
    try {
      const [, open] = ADAPTERS[0];
      const repo = await open();
      const initial = sample();
      await saveLedger(repo, initial);
      const apply = vi.spyOn(repo, 'apply');
      const p = createPersister(repo, initial, 100);

      const a = { ...initial, rules: [] };
      const b = { ...a, accounts: [] };
      p.schedule(a);
      p.schedule(b);
      expect(apply).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      await p.flush();

      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply.mock.calls[0][0].delete).toEqual({ accounts: ['acc-1'], rules: ['r1'] });
      expect(await readLedger(repo)).toEqual(migrate(b));

      p.schedule(b);
      await p.flush();
      expect(apply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('save status', () => {
    const quota = new Error('quota');

    async function setup() {
      const repo = await ADAPTERS[0][1]();
      const initial = sample();
      await saveLedger(repo, initial);
      const apply = vi.spyOn(repo, 'apply');
      const statuses: SaveStatus[] = [];
      const onError = vi.fn();
      const p = createPersister(repo, initial, 100, onError, (s) => statuses.push(s));
      return { repo, initial, apply, statuses, onError, p };
    }

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('reports a failed write and keeps the last good save as the diff base, so the next write has every edit', async () => {
      const { repo, initial, apply, statuses, onError, p } = await setup();
      apply.mockRejectedValueOnce(quota);

      const a = { ...initial, rules: [] };
      p.schedule(a);
      await vi.advanceTimersByTimeAsync(100);
      await p.flush();
      expect(statuses).toEqual([{ state: 'saving' }, { state: 'failed', error: quota }]);
      expect(onError).toHaveBeenCalledWith(quota);
      expect(await readLedger(repo)).toEqual(migrate(initial));

      const b = { ...a, accounts: [] };
      p.schedule(b);
      expect(statuses.at(-1)).toEqual({ state: 'saving' });
      await vi.advanceTimersByTimeAsync(100);
      await p.flush();
      expect(statuses.slice(2)).toEqual([{ state: 'saving' }, { state: 'saved' }]);
      expect(apply.mock.calls[1][0].delete).toEqual({ accounts: ['acc-1'], rules: ['r1'] });
      expect(await readLedger(repo)).toEqual(migrate(b));
    });

    it('retries the latest state at once after a failure', async () => {
      const { repo, initial, apply, statuses, p } = await setup();
      apply.mockRejectedValueOnce(quota);
      const a = { ...initial, rules: [] };
      p.schedule(a);
      await p.flush();
      expect(statuses.at(-1)).toEqual({ state: 'failed', error: quota });

      await p.retry();
      expect(statuses).toEqual([
        { state: 'saving' }, { state: 'failed', error: quota }, { state: 'saving' }, { state: 'saved' },
      ]);
      expect(apply).toHaveBeenCalledTimes(2);
      expect(await readLedger(repo)).toEqual(migrate(a));

      await p.retry();
      expect(apply).toHaveBeenCalledTimes(2);
    });

    it('does not report saved while a newer state is queued', async () => {
      const { repo, initial, statuses, p } = await setup();
      const a = { ...initial, rules: [] };
      const b = { ...a, accounts: [] };
      p.schedule(a);
      const first = p.flush();
      p.schedule(b);
      await first;
      expect(await readLedger(repo)).toEqual(migrate(a));
      expect(statuses).toEqual([{ state: 'saving' }]);

      await vi.advanceTimersByTimeAsync(100);
      await p.flush();
      expect(statuses).toEqual([{ state: 'saving' }, { state: 'saved' }]);
      expect(await readLedger(repo)).toEqual(migrate(b));
    });

    it('counts a commit as saving, and a failed one is not retried', async () => {
      const { repo, initial, apply, statuses, p } = await setup();
      apply.mockRejectedValueOnce(quota);
      const synced = { ...initial, lastSync: '2026-10-21T08:00:00.000Z' };
      const commit = p.commit(synced);
      expect(statuses).toEqual([{ state: 'saving' }]);
      await expect(commit).rejects.toBe(quota);
      await p.flush();
      expect(statuses).toEqual([{ state: 'saving' }, { state: 'saved' }]);

      await p.retry();
      expect(apply).toHaveBeenCalledTimes(1);
      expect(await readLedger(repo)).toEqual(migrate(initial));

      await p.commit(synced);
      expect(await readLedger(repo)).toEqual(migrate(synced));
      expect(statuses.slice(2)).toEqual([{ state: 'saving' }, { state: 'saved' }]);
    });

    it('stays unsaved when a failed commit superseded a queued edit, until it is queued again', async () => {
      const { repo, initial, apply, statuses, p } = await setup();
      apply.mockRejectedValueOnce(quota);
      const a = { ...initial, rules: [] };
      p.schedule(a);
      await expect(p.commit({ ...a, lastSync: '2026-10-21T08:00:00.000Z' })).rejects.toBe(quota);
      await p.flush();
      expect(statuses).toEqual([{ state: 'saving' }]);

      p.schedule(a);
      await p.flush();
      expect(statuses).toEqual([{ state: 'saving' }, { state: 'saved' }]);
      expect(await readLedger(repo)).toEqual(migrate(a));
    });
  });
});
