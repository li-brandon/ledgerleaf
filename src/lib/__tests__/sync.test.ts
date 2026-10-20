import { describe, expect, it } from 'vitest';
import { emptyLedger } from '../migrate';
import {
  CsvImportProvider, MockProvider, ProviderRegistry, SyncError, applySync, fetchSync, hashId, mergeSync, providers,
  type SyncProvider, type SyncResult,
} from '../sync';
import type { Account, LedgerState, Transaction } from '../types';

const now = new Date(2026, 9, 20);

const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  id, date: '2026-10-01', description: id, amount: -1, category: 'Other', accountId: 'a1', source: 'bank', ...over,
});
const account: Account = { id: 'a1', name: 'Checking', type: 'checking' };
const empty = { accounts: [], transactions: [] };

/** A provider serving fixed data, with optional failures. */
function fixedProvider(data: SyncResult, over: Partial<SyncProvider> = {}): SyncProvider & { sinces: (string | undefined)[] } {
  const sinces: (string | undefined)[] = [];
  return {
    id: 'bank', name: 'Test Bank', kind: 'demo', requiresAuth: false, sinces,
    listAccounts: async () => structuredClone(data.accounts),
    fetchTransactions: async (since) => { sinces.push(since); return structuredClone(data.transactions); },
    ...(data.balances && { fetchBalances: async () => structuredClone(data.balances!) }),
    ...over,
  };
}

async function syncOnce(state: LedgerState, p: SyncProvider, at = now) {
  return applySync(state, p.id, await fetchSync(p, state), at);
}

describe('hashId', () => {
  it('is deterministic and sensitive to input', () => {
    expect(hashId('abc')).toBe(hashId('abc'));
    expect(hashId('abc')).not.toBe(hashId('abd'));
  });
});

describe('MockProvider', () => {
  it('describes itself as a local demo provider', () => {
    const p = new MockProvider(now);
    expect({ id: p.id, kind: p.kind, requiresAuth: p.requiresAuth }).toEqual({ id: 'demo', kind: 'demo', requiresAuth: false });
  });

  it('produces ids derived from content, unique and stable across instances', async () => {
    const a = await new MockProvider(now).fetchTransactions();
    expect(a).toEqual(await new MockProvider(now).fetchTransactions());
    expect(a.every((t) => t.date <= '2026-10-20')).toBe(true);
    expect(new Set(a.map((t) => t.id)).size).toBe(a.length);
    expect(a.every((t) => t.id === `demo-${t.externalId}`)).toBe(true);
  });

  it('filters by since and keeps a day stable whichever window it falls in', async () => {
    const recent = await new MockProvider(now).fetchTransactions('2026-10-01');
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.every((t) => t.date >= '2026-10-01')).toBe(true);
    const later = await new MockProvider(new Date(2026, 11, 3)).fetchTransactions('2026-10-01');
    expect(later.filter((t) => t.date <= '2026-10-20')).toEqual(recent);
  });
});

describe('CsvImportProvider', () => {
  it('is a file provider that reports unreadable rows', async () => {
    const p = new CsvImportProvider('date,description,amount\n2026-10-01,Tea,-3\nnope,Bad,x');
    expect({ id: p.id, kind: p.kind, requiresAuth: p.requiresAuth }).toEqual({ id: 'csv', kind: 'file', requiresAuth: false });
    expect(await p.fetchTransactions()).toHaveLength(1);
    expect(p.skipped).toBe(1);
  });
});

describe('ProviderRegistry', () => {
  it('lists the built-in providers with their metadata', () => {
    expect(providers.list().map(({ id, name, kind, requiresAuth }) => ({ id, name, kind, requiresAuth }))).toEqual([
      { id: 'demo', name: 'Demo Bank (sample data)', kind: 'demo', requiresAuth: false },
      { id: 'csv', name: 'CSV import', kind: 'file', requiresAuth: false },
    ]);
    const csv = providers.get('csv');
    expect(csv?.kind === 'file' && csv.create('').id).toBe('csv');
  });

  it('rejects duplicate ids', () => {
    const entry = { id: 'x', name: 'X', kind: 'demo', requiresAuth: false, create: () => fixedProvider(empty) } as const;
    const r = new ProviderRegistry().register(entry);
    expect(() => r.register(entry)).toThrow(/already registered/);
    expect(r.list()).toHaveLength(1);
  });
});

describe('mergeSync dedupe', () => {
  it('adds 0 rows when re-syncing the same data, returning records unchanged', async () => {
    const first = mergeSync(empty, { accounts: await new MockProvider(now).listAccounts(), transactions: await new MockProvider(now).fetchTransactions() });
    expect(first.added).toBe(first.transactions.length);
    const again = mergeSync(first, { accounts: await new MockProvider(now).listAccounts(), transactions: await new MockProvider(now).fetchTransactions() });
    expect(again).toMatchObject({ added: 0, updated: 0 });
    expect(again.transactions).toHaveLength(first.transactions.length);
    again.transactions.forEach((t, i) => expect(t).toBe(first.transactions[i]));
    again.accounts.forEach((a, i) => expect(a).toBe(first.accounts[i]));
  });

  it('dedupes repeated CSV imports and keeps derived balances', async () => {
    const csv = 'date,description,amount,category,account\n2026-10-01,Tea,-3,Dining,Card';
    const read = async () => {
      const p = new CsvImportProvider(csv);
      return { accounts: await p.listAccounts(), transactions: await p.fetchTransactions() };
    };
    const once = mergeSync(empty, await read());
    const twice = mergeSync(once, await read());
    expect(twice.added).toBe(0);
    expect(twice.accounts).toHaveLength(1);
    expect(twice.accounts[0].balance).toBeUndefined();
  });

  it('matches on source + externalId even when the id changes', () => {
    const base = mergeSync(empty, { accounts: [account], transactions: [tx('t1', { externalId: 'e1' })] });
    const r = mergeSync(base, { accounts: [], transactions: [tx('t1-renamed', { externalId: 'e1' })] });
    expect(r.added).toBe(0);
    expect(r.transactions.map((t) => t.id)).toEqual(['t1']);
  });

  it('keeps the same externalId from different sources apart', () => {
    const base = mergeSync(empty, { accounts: [account], transactions: [tx('a-1', { externalId: '1' })] });
    const r = mergeSync(base, { accounts: [], transactions: [tx('b-1', { externalId: '1', source: 'other' })] });
    expect(r.added).toBe(1);
  });

  it('falls back to the hash id for rows stored before externalIds existed', () => {
    const legacy = tx('mock-abc', { source: 'mock', externalId: undefined });
    const r = mergeSync({ accounts: [account], transactions: [legacy] }, { accounts: [], transactions: [tx('mock-abc', { source: 'mock', externalId: 'abc' })] });
    expect(r).toMatchObject({ added: 0, updated: 1 });
    expect(r.transactions).toEqual([{ ...legacy, externalId: 'abc' }]);
  });

  it('dedupes by hash id when the provider has no externalIds', () => {
    const data = { accounts: [account], transactions: [tx('h1'), tx('h2')] };
    expect(mergeSync(mergeSync(empty, data), data).added).toBe(0);
  });

  it('keeps both rows when another source already uses the id, and stays idempotent', () => {
    const base = { accounts: [account], transactions: [tx('t1', { source: 'other' })] };
    const incoming = { accounts: [], transactions: [tx('t1')] };
    const once = mergeSync(base, incoming);
    expect(once.added).toBe(1);
    expect(new Set(once.transactions.map((t) => t.id)).size).toBe(2);
    expect(mergeSync(once, incoming).added).toBe(0);
  });

  it('counts duplicates within one batch once', () => {
    expect(mergeSync(empty, { accounts: [account], transactions: [tx('t1'), tx('t1')] }).transactions).toHaveLength(1);
  });

  it('sorts transactions newest first', () => {
    const r = mergeSync({ accounts: [], transactions: [tx('a', { date: '2026-01-01' })] }, { accounts: [], transactions: [tx('b', { date: '2026-02-01' })] });
    expect(r.transactions.map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('mergeSync edit preservation', () => {
  it('never overwrites category, notes, reviewed or merchant, but refreshes provider fields', () => {
    const edited = tx('t1', { externalId: 'e1', category: 'Travel', categoryId: 'travel', notes: 'trip', reviewed: true, merchant: 'Airline' });
    const incoming = tx('t1', { externalId: 'e1', amount: -2, description: 'AIRLINE POSTED', category: 'Other', categoryId: 'other', notes: undefined, reviewed: false, merchant: 'x' });
    const r = mergeSync({ accounts: [account], transactions: [edited] }, { accounts: [], transactions: [incoming] });
    expect(r).toMatchObject({ added: 0, updated: 1 });
    expect(r.transactions[0]).toEqual({ ...edited, amount: -2, description: 'AIRLINE POSTED' });
  });

  it('keeps a hidden account hidden and applies provider balances', () => {
    const r = mergeSync(
      { accounts: [{ ...account, hidden: true, balance: 1 }], transactions: [] },
      { accounts: [{ ...account, name: 'Main Checking' }], transactions: [], balances: [{ accountId: 'a1', balance: 99 }] },
    );
    expect(r.accounts).toEqual([{ ...account, name: 'Main Checking', hidden: true, balance: 99 }]);
  });

  it('keeps a name the user chose but still refreshes other provider fields', () => {
    const r = mergeSync(
      { accounts: [{ ...account, name: 'Bills', renamed: true }], transactions: [] },
      { accounts: [{ ...account, name: 'Main Checking', institution: 'Fernway' }], transactions: [] },
    );
    expect(r.accounts).toEqual([{ ...account, name: 'Bills', renamed: true, institution: 'Fernway' }]);
  });

  it('keeps edits made in the ledger through a full re-sync', async () => {
    const p = new MockProvider(now);
    const { state } = await syncOnce(emptyLedger('2026-10'), p);
    // The newest day is fetched again (it is the incremental `since`), so its rows are re-merged.
    const target = state.transactions[0];
    const edited: LedgerState = {
      ...state,
      transactions: state.transactions.map((t) =>
        t === target ? { ...t, category: 'Travel', categoryId: 'travel', notes: 'note', reviewed: true } : t),
    };
    const again = await syncOnce(edited, p);
    expect(again.received).toBeGreaterThan(0);
    expect(again.added).toBe(0);
    expect(again.state.transactions).toHaveLength(state.transactions.length);
    expect(again.state.transactions.find((t) => t.id === target.id))
      .toMatchObject({ category: 'Travel', categoryId: 'travel', notes: 'note', reviewed: true });
  });
});

describe('applySync', () => {
  it('records the last sync per provider and snapshots balances', async () => {
    const p = fixedProvider({ accounts: [account], transactions: [tx('t1')], balances: [{ accountId: 'a1', balance: 50 }] });
    const { state, added, received } = await syncOnce(emptyLedger('2026-10'), p);
    expect({ added, received }).toEqual({ added: 1, received: 1 });
    expect(state.syncs).toEqual({ bank: { lastSync: now.toISOString() } });
    expect(state.lastSync).toBe(now.toISOString());
    expect(state.accounts[0]).toMatchObject({ balance: 50, source: 'bank' });
    expect(state.balanceSnapshots).toEqual([{ accountId: 'a1', date: '2026-10-20', balance: 50, source: 'bank' }]);

    const later = new Date(2026, 9, 21);
    const next = await syncOnce(state, fixedProvider({ accounts: [], transactions: [] }, { id: 'other' }), later);
    expect(next.state.syncs).toEqual({ bank: { lastSync: now.toISOString() }, other: { lastSync: later.toISOString() } });
  });

  it('stamps the provider id as source and asks only for what is new', async () => {
    const p = fixedProvider({ accounts: [account], transactions: [tx('t1', { source: 'spoofed', date: '2026-10-05' })] });
    const { state } = await syncOnce(emptyLedger('2026-10'), p);
    expect(state.transactions[0].source).toBe('bank');
    await syncOnce(state, p);
    expect(p.sinces).toEqual([undefined, '2026-10-05']);
  });
});

describe('fetchSync errors', () => {
  const ledger = () => ({ ...emptyLedger('2026-10'), accounts: [account], transactions: [tx('t0')] });

  it('wraps provider failures in a SyncError', async () => {
    const p = fixedProvider(empty, { fetchTransactions: async () => { throw new Error('offline'); } });
    const err = await fetchSync(p, ledger()).catch((e) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect(err).toMatchObject({ providerId: 'bank', message: 'Test Bank failed: offline' });
  });

  it.each([
    ['an invalid date', { accounts: [], transactions: [tx('t1', { date: '10/01/2026' })] }, /invalid date/],
    ['a non-finite amount', { accounts: [], transactions: [tx('t1', { amount: NaN })] }, /invalid amount/],
    ['an unknown account', { accounts: [], transactions: [tx('t1', { accountId: 'nope' })] }, /unknown account/],
    ['a missing id', { accounts: [], transactions: [tx('')] }, /no id/],
    ['a bad balance', { accounts: [], transactions: [], balances: [{ accountId: 'a1', balance: Infinity }] }, /not a number/],
  ])('rejects %s without returning partial data', async (_, data, message) => {
    await expect(fetchSync(fixedProvider(data as SyncResult), ledger())).rejects.toThrow(message);
  });

  it('accepts transactions for accounts the ledger already has', async () => {
    const r = await fetchSync(fixedProvider({ accounts: [], transactions: [tx('t1')] }), ledger());
    expect(r.transactions).toHaveLength(1);
  });
});
