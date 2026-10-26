import { describe, expect, it } from 'vitest';
import { detectMapping, readCsvTable, withImportMapping } from '../csvMapping';
import { batchTransactionCount, newBatchId, recordImport, undoImport } from '../importBatches';
import { emptyLedger } from '../migrate';
import { CsvImportProvider, MockProvider, applySync, fetchSync } from '../sync';
import { editTransaction, setCategory } from '../txEdits';
import type { Account, LedgerState } from '../types';

const MONTH = '2026-10';
const DAY1 = new Date(2026, 9, 20, 9);
const DAY2 = new Date(2026, 9, 21, 9);
const everyday: Account = { id: 'csv-everyday', name: 'Everyday', type: 'checking' };
const savings: Account = { id: 'csv-savings', name: 'Savings', type: 'savings' };

const FILE = [
  'Date,Description,Amount,Category',
  '2026-10-13,Corner Grocer,-42.10,Groceries',
  '2026-10-02,Paycheck,2500.00,Income',
  '2026-10-03,Kibble Barn,-30,Pet care',
].join('\n');
const MORE = [
  'Date,Description,Amount,Category',
  '2026-10-13,Corner Grocer,-42.10,Groceries',
  '2026-10-15,Bakery,-6.50,Dining',
  '2026-10-16,Hardware,-19.99,Shopping',
].join('\n');

/** What the import screen does: run a mapped CSV provider through the sync pipeline and record the batch. */
async function importCsv(state: LedgerState, text: string, account: Account, now = DAY1, file = 'bank.csv') {
  const mapping = detectMapping(readCsvTable(text).headers);
  const newAccount = state.accounts.some((a) => a.id === account.id) ? undefined : account;
  const p = new CsvImportProvider(text, { mapping, accountId: account.id, newAccount, existing: state.transactions });
  const id = newBatchId();
  const synced = applySync(state, p.id, await fetchSync(p, state), now).state;
  const next = recordImport(withImportMapping(synced, account.id, mapping), state, {
    id, file, accountId: account.id, rows: readCsvTable(text).rows.length, at: now.toISOString(),
  });
  return { state: next, id };
}

/** Everything undo restores. Not restored on purpose: `lastSync`, `syncs` and an existing account's saved mapping. */
const meaningful = (s: LedgerState) => ({
  accounts: s.accounts, transactions: s.transactions, balanceSnapshots: s.balanceSnapshots, categories: s.categories,
  rules: s.rules, budgets: s.budgets, recurring: s.recurring, settings: s.settings, importBatches: s.importBatches,
});

/** Demo data with a hand-edited transaction, a rule and a recurring choice. */
async function base(): Promise<LedgerState> {
  const demo = new MockProvider(DAY1);
  let s = applySync(emptyLedger(MONTH), demo.id, await fetchSync(demo, emptyLedger(MONTH)), DAY1).state;
  s = setCategory(editTransaction(s, s.transactions[0].id, { merchant: 'Renamed', notes: 'mine' }), [s.transactions[0].id], 'Travel');
  return {
    ...s,
    transactions: s.transactions.map((t, i) => (i === 1 ? { ...t, reviewed: true } : t)),
    rules: [{ id: 'r1', merchantContains: 'grocer', categoryId: 'groceries' }],
    recurring: { decisions: { 'netflix|monthly': 'dismissed' }, manual: [] },
  };
}

describe('recordImport', () => {
  it('tags the added transactions and records the batch', async () => {
    const before = await base();
    const { state, id } = await importCsv(before, FILE, everyday);
    const added = state.transactions.filter((t) => t.importBatchId === id);
    expect(added.map((t) => t.description).sort()).toEqual(['Corner Grocer', 'Kibble Barn', 'Paycheck']);
    expect(state.transactions.filter((t) => t.source !== 'csv').every((t) => t.importBatchId === undefined)).toBe(true);
    expect(state.importBatches).toEqual([{
      id, file: 'bank.csv', accountId: 'csv-everyday', rows: 3, added: 3, at: DAY1.toISOString(), newAccount: true,
      categories: [expect.any(String)],
      snapshots: [{ accountId: 'csv-everyday', date: '2026-10-20', balance: 2427.9 }],
    }]);
    expect(batchTransactionCount(state, id)).toBe(3);
  });

  it('gives every import its own id, even of the same file', async () => {
    const a = await importCsv(emptyLedger(MONTH), FILE, everyday);
    const b = await importCsv(a.state, FILE, everyday);
    expect(a.id).not.toBe(b.id);
    expect(new Set(Array.from({ length: 100 }, newBatchId)).size).toBe(100);
    expect(b.state.importBatches?.map((x) => x.id)).toEqual([b.id, a.id]);
  });

  it('leaves rows that matched an existing transaction with the batch that added them', async () => {
    const a = await importCsv(emptyLedger(MONTH), FILE, everyday);
    const b = await importCsv(a.state, MORE, everyday, DAY2);
    const grocer = b.state.transactions.find((t) => t.description === 'Corner Grocer')!;
    expect(grocer.importBatchId).toBe(a.id);
    expect(batchTransactionCount(b.state, b.id)).toBe(2);
    expect(b.state.importBatches?.[0]).toMatchObject({ rows: 3, added: 2 });
    expect(b.state.importBatches?.[0].newAccount).toBeUndefined();
  });
});

describe('undoImport', () => {
  it('restores the ledger from before an import into a new account exactly', async () => {
    const before = await base();
    const { state, id } = await importCsv(before, FILE, everyday);
    expect(state.categories.length).toBe(before.categories.length + 1);

    const undone = undoImport(state, id);
    expect(meaningful(undone)).toEqual(meaningful(before));
    expect(undone.importMappings).toEqual(before.importMappings);
    // Sync bookkeeping keeps the import's time.
    expect(undone.syncs?.csv).toBeDefined();
  });

  it('restores the ledger from before an import into an existing account exactly', async () => {
    const a = await importCsv(await base(), FILE, everyday);
    // The user edits a transaction the first import added.
    const before = editTransaction(a.state, a.state.transactions.find((t) => t.importBatchId === a.id)!.id, { notes: 'checked' });
    // Same day: the second import overwrites the first one's balance snapshot.
    const b = await importCsv(before, MORE, everyday, DAY1);
    expect(b.state.importBatches?.[0].snapshots).toEqual([
      { accountId: 'csv-everyday', date: '2026-10-20', balance: 2401.41, before: expect.objectContaining({ balance: 2427.9 }) },
    ]);

    expect(meaningful(undoImport(b.state, b.id))).toEqual(meaningful(before));
  });

  it('removes a snapshot written on another day and keeps the earlier one', async () => {
    const a = await importCsv(emptyLedger(MONTH), FILE, everyday);
    const b = await importCsv(a.state, MORE, everyday, DAY2);
    expect(b.state.balanceSnapshots).toHaveLength(2);
    expect(undoImport(b.state, b.id).balanceSnapshots).toEqual(a.state.balanceSnapshots);
  });

  it('undoing one batch leaves another intact', async () => {
    const a = await importCsv(await base(), FILE, everyday);
    const b = await importCsv(a.state, MORE, savings, DAY2, 'savings.csv');

    const undone = undoImport(b.state, a.id);
    expect(undone.transactions.filter((t) => t.importBatchId === b.id)).toEqual(b.state.transactions.filter((t) => t.importBatchId === b.id));
    expect(undone.transactions.some((t) => t.importBatchId === a.id)).toBe(false);
    expect(undone.accounts.map((x) => x.id)).not.toContain('csv-everyday');
    expect(undone.accounts.map((x) => x.id)).toContain('csv-savings');
    expect(undone.importBatches).toEqual([b.state.importBatches![0]]);
    // Undoing the other one too leaves the ledger from before both.
    expect(meaningful(undoImport(undone, b.id))).toEqual(meaningful(await base()));
  });

  it('undoing a re-import of the same file removes nothing the first import added', async () => {
    const a = await importCsv(await base(), FILE, everyday);
    const b = await importCsv(a.state, FILE, everyday, DAY2);
    expect(b.state.importBatches?.[0].added).toBe(0);

    const undone = undoImport(b.state, b.id);
    expect(undone.transactions).toEqual(a.state.transactions);
    expect(undone.accounts).toEqual(a.state.accounts);
    expect(undone.importBatches).toEqual(a.state.importBatches);
  });

  it('never changes a transaction from another source or batch', async () => {
    const before = await base();
    const a = await importCsv(before, FILE, everyday);
    const paycheck = a.state.transactions.find((t) => t.description === 'Paycheck')!.id;
    const edited = setCategory(editTransaction(a.state, paycheck, { notes: 'bonus' }), [paycheck], 'Other');
    const b = await importCsv(edited, MORE, everyday, DAY2);

    const undone = undoImport(b.state, b.id);
    for (const t of edited.transactions) expect(undone.transactions).toContainEqual(t);
    expect(undone.transactions.find((t) => t.description === 'Paycheck')).toMatchObject({ notes: 'bonus', categoryEdited: true });
    expect(undone.transactions.find((t) => t.notes === 'mine')).toEqual(before.transactions.find((t) => t.notes === 'mine'));
  });

  it('keeps a created account and category that something else still uses', async () => {
    const a = await importCsv(emptyLedger(MONTH), FILE, everyday);
    const b = await importCsv(a.state, MORE, everyday, DAY2);
    const petCare = a.state.importBatches![0].categories![0];
    const withRule = { ...b.state, rules: [{ id: 'r', merchant: 'Kibble Barn', categoryId: petCare }] };

    const undone = undoImport(withRule, a.id);
    expect(undone.accounts.map((x) => x.id)).toEqual(['csv-everyday']);
    expect(undone.categories.map((c) => c.id)).toContain(petCare);
    expect(undone.transactions.map((t) => t.description).sort()).toEqual(['Bakery', 'Hardware']);
  });

  it('removes the record of a batch whose transactions are all gone', async () => {
    const a = await importCsv(emptyLedger(MONTH), FILE, everyday);
    const emptied = { ...a.state, transactions: [] };
    const undone = undoImport(emptied, a.id);
    expect(undone.importBatches).toBeUndefined();
    expect(undone.accounts).toEqual([]);
  });

  it('returns the ledger itself for an unknown batch', async () => {
    const a = await importCsv(emptyLedger(MONTH), FILE, everyday);
    expect(undoImport(a.state, 'imp-unknown')).toBe(a.state);
  });
});
