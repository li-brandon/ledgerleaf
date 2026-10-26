import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT, BACKUP_VERSION, backupFilename, makeBackup, parseBackup, restoreBackup, type Backup,
} from '../backup';
import { readLedger, saveLedger } from '../ledger';
import { emptyLedger, migrate } from '../../lib/migrate';
import { SCHEMA_VERSION, type LedgerState } from '../../lib/types';
import { ADAPTERS, makeTransactions } from './helpers';

const MONTH = '2026-10';
const NOW = new Date('2026-10-20T09:30:00.000Z');

function sample(): LedgerState {
  return {
    ...emptyLedger(MONTH),
    accounts: [{ id: 'acc-1', name: 'Checking', type: 'checking', currency: 'USD', hidden: false }],
    transactions: makeTransactions(4),
    rules: [{ id: 'r1', merchant: 'Merchant 1', categoryId: 'dining' }],
    balanceSnapshots: [{ accountId: 'acc-1', date: '2026-10-01', balance: 10 }],
    lastSync: '2026-10-19T08:00:00.000Z',
    syncs: { csv: { lastSync: '2026-10-19T08:00:00.000Z' } },
    recurring: { decisions: { 'netflix|monthly': 'confirmed' }, manual: [] },
    settings: { currency: 'EUR', monthStartDay: 15, theme: 'dark' },
  };
}

const roundTrip = (s: LedgerState) => parseBackup(JSON.stringify(makeBackup(s, NOW)));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tamper callbacks mutate arbitrary nested fields of the parsed backup JSON
const tamper = (fn: (b: Record<string, any>) => void) => {
  const b = JSON.parse(JSON.stringify(makeBackup(sample(), NOW)));
  fn(b);
  return parseBackup(JSON.stringify(b));
};

describe('makeBackup', () => {
  it('wraps every store and meta value in a versioned envelope', () => {
    const b = makeBackup(sample(), NOW);
    expect(b).toMatchObject({ format: BACKUP_FORMAT, version: BACKUP_VERSION, schemaVersion: SCHEMA_VERSION, exportedAt: NOW.toISOString() });
    expect(Object.keys(b.stores).sort()).toEqual(['accounts', 'balanceSnapshots', 'budgets', 'categories', 'rules', 'transactions']);
    expect(b.stores.transactions).toHaveLength(4);
    expect(b.meta.settings).toEqual({ currency: 'EUR', monthStartDay: 15, theme: 'dark' });
    expect(b.meta.recurring?.decisions).toEqual({ 'netflix|monthly': 'confirmed' });
  });

  it('names the file by local date', () => {
    expect(backupFilename(new Date(2026, 0, 5))).toBe('ledgerleaf-backup-2026-01-05.json');
  });
});

describe('parseBackup', () => {
  it('accepts its own output and counts each store', () => {
    const r = roundTrip(sample());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.counts).toMatchObject({ accounts: 1, transactions: 4, rules: 1, balanceSnapshots: 1 });
    expect(r.backup.stores).toEqual(makeBackup(sample(), NOW).stores);
  });

  it('rejects files that are not Ledgerleaf backups', () => {
    expect(parseBackup('not json')).toEqual({ ok: false, error: 'This file is not valid JSON.' });
    expect(parseBackup('[]')).toMatchObject({ ok: false, error: 'This is not a Ledgerleaf backup file.' });
    // A raw ledger (what the old export wrote) is not a backup either.
    expect(parseBackup(JSON.stringify(sample()))).toMatchObject({ ok: false });
  });

  it('rejects newer or missing versions', () => {
    expect(tamper((b) => { b.version = BACKUP_VERSION + 1; })).toMatchObject({ ok: false, error: expect.stringContaining('newer version') });
    expect(tamper((b) => { b.schemaVersion = SCHEMA_VERSION + 1; })).toMatchObject({ ok: false, error: expect.stringContaining('newer data schema') });
    expect(tamper((b) => { delete b.version; })).toMatchObject({ ok: false, error: 'The backup has no valid version.' });
  });

  it('rejects malformed stores and records, naming the problem', () => {
    expect(tamper((b) => { delete b.stores; })).toMatchObject({ ok: false, error: 'The backup has no data stores.' });
    expect(tamper((b) => { b.stores.transactions = {}; })).toMatchObject({ ok: false, error: 'Transactions in the backup is not a list.' });
    expect(tamper((b) => { b.stores.transactions[2].amount = '12'; }))
      .toMatchObject({ ok: false, error: 'Transactions record 3 needs a numeric amount.' });
    expect(tamper((b) => { b.stores.transactions[0].date = '10/01/2026'; }))
      .toMatchObject({ ok: false, error: 'Transactions record 1 needs a YYYY-MM-DD date.' });
    expect(tamper((b) => { b.stores.accounts.push(null); })).toMatchObject({ ok: false, error: 'Accounts record 2 is not an object.' });
    expect(tamper((b) => { b.stores.budgets[0].month = 'Oct'; })).toMatchObject({ ok: false, error: expect.stringContaining('YYYY-MM month') });
    expect(tamper((b) => { b.stores.balanceSnapshots[0].balance = null; })).toMatchObject({ ok: false, error: expect.stringContaining('numeric balance') });
  });

  it('rejects duplicate keys within a store', () => {
    expect(tamper((b) => { b.stores.transactions[1].id = b.stores.transactions[0].id; }))
      .toMatchObject({ ok: false, error: expect.stringContaining('two records with the key') });
  });

  it('treats a missing store as empty and sanitizes settings', () => {
    const r = tamper((b) => { delete b.stores.rules; b.meta.settings = { currency: 'nope', monthStartDay: 3, theme: 'dark' }; });
    expect(r.ok && r.counts.rules).toBe(0);
    expect(r.ok && r.backup.meta.settings).toEqual({ currency: 'USD', monthStartDay: 3, theme: 'dark' });
  });
});

describe('restoreBackup', () => {
  const backup = () => (roundTrip(sample()) as { backup: Backup }).backup;

  it('replace makes the ledger exactly the backup, settings included', () => {
    const current = { ...emptyLedger(MONTH), transactions: makeTransactions(2, 'other').map((t) => ({ ...t, id: `old-${t.id}` })) };
    const { state, added } = restoreBackup(current, backup(), 'replace');
    expect(state).toEqual(migrate(sample()));
    expect(state.transactions.some((t) => t.id.startsWith('old-'))).toBe(false);
    expect(added.transactions).toBe(4);
  });

  it('merge keeps current records, adds new ones and dedupes by id', () => {
    const current = migrate({
      ...emptyLedger(MONTH),
      transactions: [
        { ...makeTransactions(1)[0], description: 'Edited locally' },
        { ...makeTransactions(1)[0], id: 'local-only' },
      ],
      balanceSnapshots: [{ accountId: 'acc-1', date: '2026-10-01', balance: 99 }],
      settings: { currency: 'GBP', monthStartDay: 1, theme: 'light' },
      lastSync: '2026-10-01T00:00:00.000Z',
    });
    const { state, added } = restoreBackup(current, backup(), 'merge');
    const ids = state.transactions.map((t) => t.id);
    expect(ids).toEqual(['tx-0', 'local-only', 'tx-1', 'tx-2', 'tx-3']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(state.transactions[0].description).toBe('Edited locally');
    expect(added).toMatchObject({ transactions: 3, accounts: 1, rules: 1, balanceSnapshots: 0 });
    // Snapshots are keyed by account and day: the local one wins.
    expect(state.balanceSnapshots).toEqual([{ accountId: 'acc-1', date: '2026-10-01', balance: 99 }]);
    expect(state.settings).toEqual({ currency: 'GBP', monthStartDay: 1, theme: 'light' });
    expect(state.lastSync).toBe('2026-10-19T08:00:00.000Z');
    expect(state.recurring?.decisions).toEqual({ 'netflix|monthly': 'confirmed' });
  });

  it('merging the same backup twice adds nothing the second time', () => {
    const once = restoreBackup(emptyLedger(MONTH), backup(), 'merge').state;
    const twice = restoreBackup(once, backup(), 'merge');
    expect(Object.values(twice.added).every((n) => n === 0)).toBe(true);
    expect(twice.state.transactions).toEqual(once.transactions);
  });

  it('keeps import batches and batch ids, merging batch lists by id', () => {
    const batch = (id: string, at: string) => ({ id, file: `${id}.csv`, accountId: 'acc-1', rows: 1, added: 1, at });
    const withBatches: LedgerState = {
      ...sample(),
      transactions: sample().transactions.map((t, i) => (i === 0 ? { ...t, importBatchIds: ['imp-a', 'imp-b'] } : t)),
      importBatches: [batch('imp-b', '2026-10-19T00:00:00.000Z'), batch('imp-a', '2026-10-01T00:00:00.000Z')],
    };
    const { backup: b } = roundTrip(withBatches) as { backup: Backup };
    expect(restoreBackup(emptyLedger(MONTH), b, 'replace').state).toEqual(migrate(withBatches));

    const current = { ...emptyLedger(MONTH), importBatches: [batch('imp-c', '2026-10-10T00:00:00.000Z'), batch('imp-a', '2026-10-01T00:00:00.000Z')] };
    const merged = restoreBackup(current, b, 'merge').state;
    expect(merged.importBatches?.map((x) => x.id)).toEqual(['imp-b', 'imp-c', 'imp-a']);
    expect(merged.transactions.find((t) => t.id === 'tx-0')?.importBatchIds).toEqual(['imp-a', 'imp-b']);

    // A transaction in both keeps the current ledger's claims; they are not unioned with the backup's.
    const tx0 = { ...b.stores.transactions[0], importBatchIds: ['imp-c'] };
    const both = restoreBackup({ ...current, transactions: [tx0] }, b, 'merge').state;
    expect(both.transactions.find((t) => t.id === 'tx-0')?.importBatchIds).toEqual(['imp-c']);
  });

  it('merge takes the backup settings when the ledger has none', () => {
    expect(restoreBackup(emptyLedger(MONTH), backup(), 'merge').state.settings).toEqual(sample().settings);
  });
});

describe.each(ADAPTERS)('backups on %s', (_, open) => {
  it('persists settings and restores a backup into an empty database', async () => {
    const repo = await open();
    const s = sample();
    await saveLedger(repo, s);
    const stored = (await readLedger(repo))!;
    expect(stored.settings).toEqual(s.settings);

    const restored = restoreBackup(emptyLedger(MONTH), (parseBackup(JSON.stringify(makeBackup(stored, NOW))) as { backup: Backup }).backup, 'replace').state;
    const other = await open();
    await saveLedger(other, restored);
    expect(await readLedger(other)).toEqual(stored);
  });
});
