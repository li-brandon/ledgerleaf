import { describe, expect, it } from 'vitest';
import { makeBackup, parseBackup, restoreBackup } from '../../db/backup';
import { createMemoryRepository, readLedger, saveLedger } from '../../db';
import { detectMapping, matchExisting, readCsvTable, withImportMapping } from '../csvMapping';
import { monthlySpend } from '../insights';
import { batchTransactionCount, newBatchId, recordImport, undoImport } from '../importBatches';
import { emptyLedger, migrate } from '../migrate';
import { detectRecurring } from '../recurring';
import { CsvImportProvider, applySync, fetchSync } from '../sync';
import { deleteTransaction, editTransaction, restoreTransaction } from '../txEdits';
import type { Account, LedgerState, Transaction } from '../types';

const DAY1 = new Date(2026, 9, 20, 9);
const DAY2 = new Date(2026, 9, 21, 9);
const everyday: Account = { id: 'csv-everyday', name: 'Everyday', type: 'checking' };

const FILE = [
  'Date,Description,Amount,Category',
  '2026-10-13,Corner Grocer,-42.10,Groceries',
  '2026-10-02,Paycheck,2500.00,Income',
  '2026-10-03,Kibble Barn,-30,Pet care',
].join('\n');

/** What the import screen does: a mapped CSV provider through the sync pipeline, recorded as a batch. */
async function importCsv(state: LedgerState, text: string, now = DAY1) {
  const mapping = detectMapping(readCsvTable(text).headers);
  const newAccount = state.accounts.some((a) => a.id === everyday.id) ? undefined : everyday;
  const p = new CsvImportProvider(text, {
    mapping, accountId: everyday.id, newAccount, existing: state.transactions, deleted: state.deletedTransactions,
  });
  const id = newBatchId();
  const sync = applySync(state, p.id, await fetchSync(p, state), now);
  const fileIds = (await p.fetchTransactions()).map((t) => t.id);
  const next = recordImport(withImportMapping(sync.state, everyday.id, mapping), state, {
    id, file: 'bank.csv', accountId: everyday.id, rows: readCsvTable(text).rows.length, at: now.toISOString(),
  }, fileIds);
  return { state: next, id, added: sync.added, received: sync.received, deleted: p.deleted };
}

const find = (s: LedgerState, description: string) => s.transactions.find((t) => t.description === description);
const grocer = (s: LedgerState) => find(s, 'Corner Grocer')!;

describe('deleteTransaction', () => {
  it('removes the row and remembers its identity', async () => {
    const { state } = await importCsv(emptyLedger('2026-10'), FILE);
    const t = grocer(state);
    const next = deleteTransaction(state, t.id);
    expect(next.transactions.map((x) => x.description)).toEqual(['Kibble Barn', 'Paycheck']);
    expect(next.deletedTransactions).toEqual([{
      id: t.id, accountId: t.accountId, date: t.date, description: t.description, amount: t.amount, source: 'csv', externalId: t.externalId,
    }]);
    // Spending (budgets, insights) is derived from the transactions.
    expect(monthlySpend(state.transactions, ['2026-10'])[0].byCategory.Groceries).toBe(42.1);
    expect(monthlySpend(next.transactions, ['2026-10'])[0].byCategory.Groceries).toBeUndefined();
  });

  it('removes the row from recurring detection', () => {
    const charge = (id: string, date: string): Transaction => ({
      id, date, description: 'NETFLIX', merchant: 'NETFLIX', amount: -15.49, category: 'Entertainment', accountId: 'a1',
    });
    const state = { ...emptyLedger('2026-10'), transactions: [charge('n3', '2026-10-05'), charge('n2', '2026-09-05'), charge('n1', '2026-08-05')] };
    expect(detectRecurring(state.transactions)).toHaveLength(1);
    expect(detectRecurring(deleteTransaction(state, 'n2').transactions)).toHaveLength(0);
  });

  it('returns the ledger itself for an unknown id', () => {
    const state = emptyLedger('2026-10');
    expect(deleteTransaction(state, 'nope')).toBe(state);
  });
});

describe('a deleted transaction stays deleted', () => {
  it('re-importing the same CSV file does not add it back or count it as added', async () => {
    const first = await importCsv(emptyLedger('2026-10'), FILE);
    const deleted = deleteTransaction(first.state, grocer(first.state).id);
    const again = await importCsv(deleted, FILE, DAY2);
    expect(find(again.state, 'Corner Grocer')).toBeUndefined();
    expect(again.state.transactions).toHaveLength(2);
    expect(again).toMatchObject({ added: 0, received: 2, deleted: 1 });
    expect(again.state.importBatches?.[0].added).toBe(0);
  });

  it('the import preview leaves it out too', async () => {
    const first = await importCsv(emptyLedger('2026-10'), FILE);
    const state = deleteTransaction(first.state, grocer(first.state).id);
    const mapping = detectMapping(readCsvTable(FILE).headers);
    const mapped = await new CsvImportProvider(FILE, { mapping, accountId: everyday.id }).fetchTransactions();
    const m = matchExisting(mapped, state.transactions, state.deletedTransactions);
    expect(m.transactions.map((t) => t.description)).toEqual(['Paycheck', 'Kibble Barn']);
    expect([...m.deleted].map((t) => t.description)).toEqual(['Corner Grocer']);
  });

  it('only one of two identical rows is held back when one was deleted, and a new one gets its own id', async () => {
    const twice = `${FILE}\n2026-10-13,Corner Grocer,-42.10,Groceries`;
    const first = await importCsv(emptyLedger('2026-10'), twice);
    const [a, b] = first.state.transactions.filter((t) => t.description === 'Corner Grocer');
    const state = deleteTransaction(first.state, a.id);
    const again = await importCsv(state, twice, DAY2);
    expect(again.state.transactions.filter((t) => t.description === 'Corner Grocer').map((t) => t.id)).toEqual([b.id]);
    expect(again.deleted).toBe(1);
    // A third identical row is new: it must not take the deleted row's id (which merging would leave out).
    const thrice = await importCsv(again.state, `${twice}\n2026-10-13,Corner Grocer,-42.10,Groceries`, DAY2);
    const ids = thrice.state.transactions.filter((t) => t.description === 'Corner Grocer').map((t) => t.id);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(a.id);
  });

  it('a re-sync of the provider does not add it back, even with changed fields', () => {
    const account: Account = { id: 'plaid-acc', name: 'Card', type: 'credit' };
    const row: Transaction = {
      id: 'plaid-tx1', externalId: 'tx1', source: 'plaid', date: '2026-10-10', description: 'Cafe', amount: -5, category: 'Dining', accountId: account.id,
    };
    const synced = applySync(emptyLedger('2026-10'), 'plaid', { accounts: [account], transactions: [row] }, DAY1).state;
    const deleted = deleteTransaction(synced, 'plaid-tx1');
    const again = applySync(deleted, 'plaid', { accounts: [account], transactions: [{ ...row, amount: -6, pending: false }] }, DAY2);
    expect(again.added).toBe(0);
    expect(again.state.transactions).toEqual([]);
    expect(again.state.deletedTransactions).toEqual(deleted.deletedTransactions);
  });
});

describe('restoreTransaction', () => {
  it('puts the row back exactly, batch claims included, and forgets the tombstone', async () => {
    const { state, id } = await importCsv(emptyLedger('2026-10'), FILE);
    const t = grocer(state);
    expect(t.importBatchIds).toEqual([id]);
    const restored = restoreTransaction(deleteTransaction(state, t.id), t);
    expect(restored.transactions).toEqual(state.transactions);
    expect(grocer(restored)).toBe(t);
    expect(restored.deletedTransactions).toBeUndefined();
    // Re-importing finds it held again.
    expect((await importCsv(restored, FILE, DAY2)).state.transactions).toHaveLength(3);
  });

  it('keeps edits made since the delete, and is a no-op once the row is back', async () => {
    const { state } = await importCsv(emptyLedger('2026-10'), FILE);
    const t = grocer(state);
    const paycheck = find(state, 'Paycheck')!.id;
    const edited = editTransaction(deleteTransaction(state, t.id), paycheck, { notes: 'October' });
    const restored = restoreTransaction(edited, t);
    expect(find(restored, 'Paycheck')!.notes).toBe('October');
    expect(grocer(restored)).toBe(t);
    expect(restoreTransaction(restored, t)).toBe(restored);
  });

  it('drops claims of imports undone since the delete', async () => {
    const first = await importCsv(emptyLedger('2026-10'), FILE);
    const second = await importCsv(first.state, FILE, DAY2);
    const t = grocer(second.state);
    expect(t.importBatchIds).toEqual([first.id, second.id]);
    const undone = undoImport(deleteTransaction(second.state, t.id), first.id);
    const restored = restoreTransaction(undone, t);
    expect(grocer(restored)).toEqual({ ...t, importBatchIds: [second.id] });
    // Undoing the remaining import now removes it as usual.
    expect(find(undoImport(restored, second.id), 'Corner Grocer')).toBeUndefined();
  });

  it('leaves the row deleted when every import that claimed it was undone', async () => {
    const { state, id } = await importCsv({ ...emptyLedger('2026-10'), accounts: [everyday] }, FILE);
    const t = grocer(state);
    const undone = undoImport(deleteTransaction(state, t.id), id);
    expect(undone.accounts.map((a) => a.id)).toEqual([everyday.id]);
    const restored = restoreTransaction(undone, t);
    expect(restored.transactions).toEqual([]);
    expect(restored.deletedTransactions).toBeUndefined();
  });

  it('leaves the row deleted when its account is gone', () => {
    const t: Transaction = { id: 'x', date: '2026-10-01', description: 'X', amount: -1, category: 'Other', accountId: 'gone' };
    const state = deleteTransaction({ ...emptyLedger('2026-10'), transactions: [t] }, 'x');
    expect(restoreTransaction(state, t).transactions).toEqual([]);
  });
});

describe('undoImport after a delete', () => {
  it('counts and removes only the rows left, and restores the ledger from before the import', async () => {
    const before = emptyLedger('2026-10');
    const { state, id } = await importCsv(before, FILE);
    const deleted = deleteTransaction(state, grocer(state).id);
    expect(batchTransactionCount(deleted, id)).toBe(2);
    const undone = undoImport(deleted, id);
    expect(undone.transactions).toEqual([]);
    expect(undone.accounts).toEqual(before.accounts);
    expect(undone.balanceSnapshots).toEqual(before.balanceSnapshots);
    expect(undone.importBatches).toBeUndefined();
  });

  it('recomputes a remaining import\'s snapshot without the deleted row', async () => {
    const first = await importCsv(emptyLedger('2026-10'), FILE);
    const more = 'Date,Description,Amount\n2026-10-15,Bakery,-6.50';
    // Same day: the second import takes over the snapshot, so undoing it recomputes the first one's.
    const second = await importCsv(first.state, more, DAY1);
    const deleted = deleteTransaction(second.state, grocer(second.state).id);
    const undone = undoImport(deleted, second.id);
    // The balance of what is left of the first import: 2500 - 30.
    expect(undone.balanceSnapshots.map((s) => [s.date, s.balance])).toEqual([['2026-10-20', 2470]]);
  });
});

describe('persisting tombstones', () => {
  async function deletedLedger() {
    const { state } = await importCsv(emptyLedger('2026-10'), FILE);
    return deleteTransaction(state, grocer(state).id);
  }

  it('saves and loads them', async () => {
    const state = await deletedLedger();
    const repo = createMemoryRepository();
    await saveLedger(repo, emptyLedger('2026-10'));
    await saveLedger(repo, state, emptyLedger('2026-10'));
    expect((await readLedger(repo))!.deletedTransactions).toEqual(state.deletedTransactions);
  });

  it('a backup round trip keeps them (replace)', async () => {
    const state = await deletedLedger();
    const parsed = parseBackup(JSON.stringify(makeBackup(state)));
    if (!parsed.ok) throw new Error(parsed.error);
    const restored = restoreBackup(emptyLedger('2026-10'), parsed.backup, 'replace').state;
    expect(restored.deletedTransactions).toEqual(state.deletedTransactions);
    expect(find((await importCsv(restored, FILE, DAY2)).state, 'Corner Grocer')).toBeUndefined();
  });

  it('merging a backup unions them, and never brings back a row the ledger deleted', async () => {
    const { state } = await importCsv(emptyLedger('2026-10'), FILE);
    // The backup holds Corner Grocer and Paycheck, and deleted Kibble Barn.
    const backup = makeBackup(deleteTransaction(state, find(state, 'Kibble Barn')!.id));
    const current = { ...emptyLedger('2026-10'), deletedTransactions: deleteTransaction(state, grocer(state).id).deletedTransactions };
    const merged = restoreBackup(current, backup, 'merge');
    expect(merged.state.transactions.map((t) => t.description)).toEqual(['Paycheck']);
    expect(merged.added.transactions).toBe(1);
    expect(merged.state.deletedTransactions?.map((d) => d.description)).toEqual(['Corner Grocer', 'Kibble Barn']);

    // A backup's tombstone of a row the ledger still holds is dropped: the ledger wins.
    const kept = restoreBackup(state, backup, 'merge').state;
    expect(kept.transactions).toHaveLength(3);
    expect(kept.deletedTransactions).toBeUndefined();
  });

  it('normalizes stored tombstones, dropping malformed ones and unknown keys', () => {
    const good = { id: 'csv-1', accountId: 'a', date: '2026-10-01', description: 'X', amount: -1, source: 'csv', externalId: '1' };
    const out = migrate({
      version: 2,
      deletedTransactions: [{ ...good, notes: 'gone', extra: 1 }, { id: 'csv-2', accountId: 'a' }, { ...good, amount: Number.NaN }, 'x', null],
    });
    expect(out.deletedTransactions).toEqual([good]);
    expect(migrate({ version: 2, deletedTransactions: 'nope' })).not.toHaveProperty('deletedTransactions');
  });
});
