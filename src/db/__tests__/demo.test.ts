import { describe, expect, it, vi } from 'vitest';
import { clearDemoData, demoCounts, withoutDemo } from '../demo';
import { readLedger, saveLedger } from '../ledger';
import { emptyLedger } from '../../lib/migrate';
import { CsvImportProvider, MockProvider, applySync, fetchSync, type SyncProvider } from '../../lib/sync';
import type { LedgerState } from '../../lib/types';
import { ADAPTERS } from './helpers';

const now = new Date(2026, 9, 20);

async function sync(state: LedgerState, p: SyncProvider) {
  return applySync(state, p.id, await fetchSync(p, state), now).state;
}

/** Demo data, a CSV import into its own new account, and one CSV row added to the demo checking account. */
async function mixedLedger() {
  let state = await sync(emptyLedger('2026-10'), new MockProvider(now));
  const tea = { id: 'csv-tea', name: 'Tea fund', type: 'checking' as const };
  const mapping = { date: 'When', description: 'What', amount: 'Amount' };
  state = await sync(state, new CsvImportProvider('When,What,Amount\n2026-10-01,Tea,-3\n2026-10-02,Cake,-5', {
    mapping, accountId: tea.id, newAccount: tea,
  }));
  state = await sync(state, new CsvImportProvider('When,What,Amount\n2026-10-03,Refund,12', { mapping, accountId: 'demo-checking' }));
  return { ...state, importMappings: { 'csv-tea': mapping, 'demo-card': mapping } };
}

describe('withoutDemo', () => {
  it('removes demo rows and keeps imported ones', async () => {
    const state = await mixedLedger();
    expect(demoCounts(state)).toMatchObject({ accounts: 3, balanceSnapshots: 48 });
    const next = withoutDemo(state);

    expect(next.transactions.map((t) => t.description).sort()).toEqual(['Cake', 'Refund', 'Tea']);
    expect(next.transactions.every((t) => t.source === 'csv')).toBe(true);
    // Only the imported account's own snapshot (its derived balance on import) is left.
    expect(next.balanceSnapshots).toEqual([{ accountId: 'csv-tea', date: '2026-10-20', balance: -8, source: 'csv' }]);
    // The demo checking account holds an imported row, so it stays as a plain account.
    expect(next.accounts.map((a) => a.id).sort()).toEqual(['csv-tea', 'demo-checking']);
    const checking = next.accounts.find((a) => a.id === 'demo-checking')!;
    expect(checking.source).toBeUndefined();
    expect(checking.balance).toBeUndefined();
    expect(Object.keys(next.syncs ?? {})).toEqual(['csv']);
    expect(next.lastSync).toBe(state.syncs!.csv.lastSync);
    expect(next.importMappings).toEqual({ 'csv-tea': state.importMappings['csv-tea'] });
    expect(next.categories).toBe(state.categories);
    expect(next.budgets).toBe(state.budgets);
    // Kept records are the same objects, so a save only writes the deletions.
    const tea = state.transactions.find((t) => t.description === 'Tea');
    expect(next.transactions).toContain(tea);
    expect(demoCounts(next)).toEqual({ accounts: 0, transactions: 0, balanceSnapshots: 0 });
  });

  it('returns the ledger itself when there is no demo data', async () => {
    const state = await sync(emptyLedger('2026-10'), new CsvImportProvider('date,description,amount\n2026-10-01,Tea,-3'));
    expect(withoutDemo(state)).toBe(state);
  });

  it('treats data from the old mock provider as demo data', () => {
    const state: LedgerState = {
      ...emptyLedger('2026-10'),
      accounts: [{ id: 'demo-checking', name: 'Fernway Checking', type: 'checking', balance: 10 }],
      transactions: [{ id: 'mock-1', date: '2026-10-01', description: 'Rent', amount: -1, category: 'Rent', accountId: 'demo-checking', source: 'mock' }],
      balanceSnapshots: [{ accountId: 'demo-checking', date: '2026-10-01', balance: 10 }],
      syncs: { mock: { lastSync: '2026-10-01T00:00:00.000Z' } },
      lastSync: '2026-10-01T00:00:00.000Z',
    };
    const next = withoutDemo(state);
    expect(next).toMatchObject({ accounts: [], transactions: [], balanceSnapshots: [], syncs: undefined, lastSync: undefined });
  });
});

describe.each(ADAPTERS)('clearDemoData with %s', (_, open) => {
  it('removes stored demo data and preserves imported data', async () => {
    const repo = await open();
    const state = await mixedLedger();
    await saveLedger(repo, state);

    const cleared = await clearDemoData(repo);
    const stored = await readLedger(repo);
    expect(stored).toEqual(cleared);
    expect(stored!.transactions.map((t) => t.description).sort()).toEqual(['Cake', 'Refund', 'Tea']);
    expect(stored!.accounts.map((a) => a.id).sort()).toEqual(['csv-tea', 'demo-checking']);
    expect(stored!.balanceSnapshots).toEqual([{ accountId: 'csv-tea', date: '2026-10-20', balance: -8, source: 'csv' }]);
    expect(Object.keys(stored!.syncs ?? {})).toEqual(['csv']);
    const { records } = await repo.readAll();
    expect(records.transactions.some((t) => t.source === 'demo')).toBe(false);
    expect(records.balanceSnapshots).toHaveLength(1);
  });

  it('writes the removal as one atomic batch and changes nothing if it fails', async () => {
    const repo = await open();
    await saveLedger(repo, await mixedLedger());
    const before = await repo.readAll();

    const apply = vi.spyOn(repo, 'apply').mockRejectedValueOnce(new Error('quota'));
    await expect(clearDemoData(repo)).rejects.toThrow('quota');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(await repo.readAll()).toEqual(before);

    await clearDemoData(repo);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1][0].clear).toBeUndefined();
  });

  it('is a no-op without a ledger or without demo data', async () => {
    const repo = await open();
    expect(await clearDemoData(repo)).toBeUndefined();
    const plain = emptyLedger('2026-10');
    await saveLedger(repo, plain);
    const apply = vi.spyOn(repo, 'apply');
    expect(await clearDemoData(repo)).toEqual(await readLedger(repo));
    expect(apply).not.toHaveBeenCalled();
  });
});
