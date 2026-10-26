import { describe, expect, it } from 'vitest';
import { makeBackup, parseBackup, restoreBackup, type Backup } from '../../db/backup';
import { detectMapping, readCsvTable, withImportMapping } from '../csvMapping';
import { batchTransactionCount, newBatchId, recordImport, undoImport } from '../importBatches';
import { emptyLedger } from '../migrate';
import { netWorthTrend } from '../overview';
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
  const fileIds = (await p.fetchTransactions()).map((t) => t.id);
  const next = recordImport(withImportMapping(synced, account.id, mapping), state, {
    id, file, accountId: account.id, rows: readCsvTable(text).rows.length, at: now.toISOString(),
  }, fileIds);
  return { state: next, id };
}

/** An import as it ran before batches were recorded: through the sync pipeline only, rows left untagged. */
async function importUntagged(state: LedgerState, text: string, account: Account, now = DAY1) {
  const mapping = detectMapping(readCsvTable(text).headers);
  const newAccount = state.accounts.some((a) => a.id === account.id) ? undefined : account;
  const p = new CsvImportProvider(text, { mapping, accountId: account.id, newAccount, existing: state.transactions });
  return withImportMapping(applySync(state, p.id, await fetchSync(p, state), now).state, account.id, mapping);
}

/** Net worth as the Dashboard's trend shows it for this month. */
const worth = (s: LedgerState) => netWorthTrend(s.accounts, s.balanceSnapshots, MONTH, 12).at(-1)?.total;
const everydaySnapshots = (s: LedgerState) => s.balanceSnapshots.filter((x) => x.accountId === everyday.id).map((x) => [x.date, x.balance]);
const everydayTotal = (s: LedgerState) =>
  Math.round(s.transactions.filter((t) => t.accountId === everyday.id).reduce((a, t) => a + t.amount, 0) * 100) / 100;

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
    const added = state.transactions.filter((t) => t.importBatchIds?.includes(id));
    expect(added.map((t) => t.description).sort()).toEqual(['Corner Grocer', 'Kibble Barn', 'Paycheck']);
    expect(state.transactions.filter((t) => t.source !== 'csv').every((t) => t.importBatchIds === undefined)).toBe(true);
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

  it('tags rows that matched an existing transaction with every batch whose file had them', async () => {
    const a = await importCsv(emptyLedger(MONTH), FILE, everyday);
    const b = await importCsv(a.state, MORE, everyday, DAY2);
    const grocer = b.state.transactions.find((t) => t.description === 'Corner Grocer')!;
    expect(grocer.importBatchIds).toEqual([a.id, b.id]);
    expect(b.state.transactions.find((t) => t.description === 'Paycheck')!.importBatchIds).toEqual([a.id]);
    // Corner Grocer stays when either batch is undone alone.
    expect(batchTransactionCount(b.state, a.id)).toBe(2);
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
    const before = editTransaction(a.state, a.state.transactions.find((t) => t.importBatchIds?.includes(a.id))!.id, { notes: 'checked' });
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
    expect(undone.transactions.filter((t) => t.importBatchIds?.includes(b.id))).toEqual(b.state.transactions.filter((t) => t.importBatchIds?.includes(b.id)));
    expect(undone.transactions.some((t) => t.importBatchIds?.includes(a.id))).toBe(false);
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
    // Corner Grocer was in both files, so it stays with the later import.
    expect(undone.transactions.map((t) => t.description).sort()).toEqual(['Bakery', 'Corner Grocer', 'Hardware']);
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

  describe('undoing an import that is not the newest', () => {
    it('a day apart: recomputes the newer snapshot from the rows left, then restores the ledger', async () => {
      const before = await base();
      expect(worth(before)).toBe(63766.49);
      const a = await importCsv(before, FILE, everyday, DAY1);
      const b = await importCsv(a.state, MORE, everyday, DAY2);

      const undone = undoImport(b.state, a.id);
      // Corner Grocer was in both files, so MORE keeps it: -42.10 - 6.50 - 19.99.
      expect(everydayTotal(undone)).toBe(-68.59);
      expect(everydaySnapshots(undone)).toEqual([['2026-10-21', -68.59]]);
      expect(undone.importBatches?.[0].snapshots).toEqual([{ accountId: everyday.id, date: '2026-10-21', balance: -68.59 }]);
      expect(worth(undone)).toBe(63697.9);

      expect(meaningful(undoImport(undone, b.id))).toEqual(meaningful(before));
    });

    it('on the same day: the newer import takes over the snapshot and the pre-import value, then the ledger is restored', async () => {
      const before = await base();
      const a = await importCsv(before, FILE, everyday, DAY1);
      const b = await importCsv(a.state, MORE, everyday, DAY1);
      expect(everydaySnapshots(b.state)).toEqual([['2026-10-20', 2401.41]]);

      const undone = undoImport(b.state, a.id);
      expect(everydaySnapshots(undone)).toEqual([['2026-10-20', -68.59]]);
      // MORE's record now holds FILE's "before": no snapshot at all.
      expect(undone.importBatches?.[0].snapshots).toEqual([{ accountId: everyday.id, date: '2026-10-20', balance: -68.59 }]);
      expect(worth(undone)).toBe(63697.9);

      const both = undoImport(undone, b.id);
      expect(worth(both)).toBe(63766.49);
      expect(meaningful(both)).toEqual(meaningful(before));
    });

    it('recomputes an earlier remaining import\'s balance when the newest one is undone', async () => {
      const a = await importCsv(emptyLedger(MONTH), FILE, everyday, DAY1);
      const b = await importCsv(a.state, MORE, everyday, DAY1);
      const c = await importCsv(b.state, 'Date,Description,Amount\n2026-10-17,Cafe,-4', everyday, DAY1);
      // Undo the middle one, then the newest: the snapshot ends at FILE's balance.
      const undone = undoImport(undoImport(c.state, b.id), c.id);
      expect(everydaySnapshots(undone)).toEqual([['2026-10-20', 2427.9]]);
      expect(meaningful(undone)).toEqual(meaningful(a.state));
    });

    it('recomputes each remaining import\'s snapshot from only the rows that existed when it ran', async () => {
      const DAY3 = new Date(2026, 9, 22, 9);
      const a = await importCsv(emptyLedger(MONTH), FILE, everyday, DAY1);
      const b = await importCsv(a.state, MORE, everyday, DAY2);
      const c = await importCsv(b.state, 'Date,Description,Amount\n2026-10-17,Cafe,-4', everyday, DAY3);
      const undone = undoImport(c.state, a.id);
      // MORE's Oct 21 snapshot leaves out the Cafe row imported on Oct 22.
      expect(everydaySnapshots(undone)).toEqual([['2026-10-21', -68.59], ['2026-10-22', -72.59]]);
    });

    it('leaves a snapshot another sync rewrote since the import alone', async () => {
      const a = await importCsv(emptyLedger(MONTH), FILE, everyday, DAY1);
      const b = await importCsv(a.state, MORE, everyday, DAY2);
      const rewritten = {
        ...b.state,
        balanceSnapshots: b.state.balanceSnapshots.map((x) => (x.date === '2026-10-21' ? { ...x, balance: 999, source: 'plaid' } : x)),
      };
      expect(everydaySnapshots(undoImport(rewritten, a.id))).toEqual([['2026-10-21', 999]]);
      // Without the rewrite it is recomputed.
      expect(everydaySnapshots(undoImport(b.state, a.id))).toEqual([['2026-10-21', -68.59]]);
    });
  });

  describe('rows in more than one file', () => {
    it('keeps a row a remaining import\'s file also had, and removes it with the last one', async () => {
      const a = await importCsv(await base(), FILE, everyday, DAY1);
      const b = await importCsv(a.state, MORE, everyday, DAY2);
      expect(batchTransactionCount(b.state, a.id)).toBe(2);
      expect(batchTransactionCount(b.state, b.id)).toBe(2);

      const undone = undoImport(b.state, a.id);
      const csv = undone.transactions.filter((t) => t.accountId === everyday.id);
      expect(csv.map((t) => t.description).sort()).toEqual(['Bakery', 'Corner Grocer', 'Hardware']);
      expect(csv.find((t) => t.description === 'Corner Grocer')!.importBatchIds).toEqual([b.id]);
      expect(batchTransactionCount(undone, b.id)).toBe(3);

      expect(undoImport(undone, b.id).transactions.some((t) => t.accountId === everyday.id)).toBe(false);
    });

    it.each([['a day apart', DAY2], ['on the same day', DAY1]] as const)(
      'never claims a row imported before batches were recorded, %s', async (_, day) => {
        const before = await importUntagged(await base(), FILE, everyday);
        const b = await importCsv(before, MORE, everyday, day);
        expect(b.state.transactions.find((t) => t.description === 'Corner Grocer')!.importBatchIds).toBeUndefined();
        expect(b.state.importBatches?.[0].added).toBe(2);
        expect(batchTransactionCount(b.state, b.id)).toBe(2);

        // Corner Grocer stays, and the snapshot goes back to the pre-import one (or away, if MORE wrote a new day's).
        const undone = undoImport(b.state, b.id);
        expect(everydaySnapshots(undone)).toEqual([['2026-10-20', 2427.9]]);
        expect(meaningful(undone)).toEqual(meaningful(before));
      });

    it('counts untagged rows as existing when recomputing a remaining import\'s snapshot', async () => {
      const DAY3 = new Date(2026, 9, 22, 9);
      const a = await importCsv(await importUntagged(emptyLedger(MONTH), FILE, everyday), MORE, everyday, DAY2);
      const c = await importCsv(a.state, 'Date,Description,Amount\n2026-10-17,Cafe,-4', everyday, DAY3);
      // FILE's rows (Corner Grocer too) and Cafe remain: 2427.9 - 4.
      expect(everydaySnapshots(undoImport(c.state, a.id))).toEqual([['2026-10-20', 2427.9], ['2026-10-22', 2423.9]]);
    });

    it('never claims a row restored from a backup made before batches were recorded', async () => {
      const a = await importCsv(emptyLedger(MONTH), FILE, everyday);
      const old = JSON.parse(JSON.stringify(makeBackup(a.state)));
      for (const t of old.stores.transactions) delete t.importBatchIds;
      delete old.meta.importBatches;
      const restored = restoreBackup(emptyLedger(MONTH), (parseBackup(JSON.stringify(old)) as { backup: Backup }).backup, 'replace').state;
      expect(restored.transactions.some((t) => t.importBatchIds)).toBe(false);

      const b = await importCsv(restored, FILE, everyday, DAY2);
      expect(batchTransactionCount(b.state, b.id)).toBe(0);
      expect(meaningful(undoImport(b.state, b.id))).toEqual(meaningful(restored));
    });

    it('never deletes a row no import claims', async () => {
      const a = await importCsv(emptyLedger(MONTH), FILE, everyday);
      const untagged = { ...a.state, transactions: a.state.transactions.map((t) => (t.description === 'Paycheck' ? { ...t, importBatchIds: undefined } : t)) };
      expect(batchTransactionCount(untagged, a.id)).toBe(2);
      const undone = undoImport(untagged, a.id);
      expect(undone.transactions.map((t) => t.description)).toEqual(['Paycheck']);
      expect(undone.accounts.map((x) => x.id)).toEqual([everyday.id]);
    });
  });

  describe('created account, rules and categories', () => {
    it.each([['older', 0], ['newer', 1]] as const)('removes the account once the last import is undone, the %s one first', async (_, first) => {
      const before = await base();
      const a = await importCsv(before, FILE, everyday, DAY1);
      const b = await importCsv(a.state, MORE, everyday, DAY1);
      const rule = { id: 'r-everyday', merchantContains: 'bakery', categoryId: 'dining', accountId: everyday.id };
      const ids = [a.id, b.id];
      const once = undoImport({ ...b.state, rules: [...b.state.rules, rule] }, ids[first]);
      expect(once.accounts.map((x) => x.id)).toContain(everyday.id);
      expect(once.rules).toContainEqual(rule);
      expect(once.importBatches?.[0].newAccount).toBe(true);

      const both = undoImport(once, ids[1 - first]);
      expect(both.accounts.map((x) => x.id)).not.toContain(everyday.id);
      expect(both.rules).toEqual(before.rules);
      expect(meaningful(both)).toEqual(meaningful(before));
    });

    it('removes rules scoped to a removed account before checking which categories are used', async () => {
      const before = await base();
      const a = await importCsv(before, FILE, everyday);
      const petCare = a.state.importBatches![0].categories![0];
      const rule = { id: 'r-pet', merchantContains: 'kibble', categoryId: petCare, accountId: everyday.id };
      const undone = undoImport({ ...a.state, rules: [...a.state.rules, rule] }, a.id);
      expect(undone.rules).toEqual(before.rules);
      expect(undone.categories).toEqual(before.categories);
    });

    it('keeps a created category a budget or another account\'s transaction uses, and removes an unused one', async () => {
      const before = await base();
      const a = await importCsv(before, FILE, everyday);
      const petCare = a.state.importBatches![0].categories![0];

      const budget = { id: 'bud-pet', categoryId: petCare, month: MONTH, amount: 50, rollover: false };
      expect(undoImport({ ...a.state, budgets: [...a.state.budgets, budget] }, a.id).categories.map((c) => c.id)).toContain(petCare);

      const other = before.transactions[2].id;
      const recategorized = { ...a.state, transactions: a.state.transactions.map((t) => (t.id === other ? { ...t, categoryId: petCare, category: 'Pet care' } : t)) };
      expect(undoImport(recategorized, a.id).categories.map((c) => c.id)).toContain(petCare);

      expect(undoImport(a.state, a.id).categories.map((c) => c.id)).not.toContain(petCare);
    });

    it('hands a still-used created category on to the remaining import, which removes it once unused', async () => {
      const a = await importCsv(emptyLedger(MONTH), FILE, everyday, DAY1);
      const b = await importCsv(a.state, MORE, everyday, DAY2);
      const petCare = a.state.importBatches![0].categories![0];
      const withRule = { ...b.state, rules: [{ id: 'r', merchant: 'Kibble Barn', categoryId: petCare }] };
      const once = undoImport(withRule, a.id);
      expect(once.importBatches?.[0].categories).toEqual([petCare]);
      const both = undoImport({ ...once, rules: [] }, b.id);
      expect(both.categories.map((c) => c.id)).not.toContain(petCare);
    });
  });
});
