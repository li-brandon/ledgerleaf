/**
 * Full JSON backups: every store plus the small meta values, wrapped in a versioned
 * envelope. Parsing validates the file before anything is touched; restoring either
 * replaces the ledger or merges into it, skipping records whose key is already present.
 * Pure, so it can be unit tested.
 */
import { normalizeLedger } from '../lib/migrate';
import { normalizeSettings } from '../lib/settings';
import { dedupeKey } from '../lib/sync/merge';
import {
  SCHEMA_VERSION, type DeletedTransaction, type ImportBatch, type LedgerState, type RecurringSettings,
} from '../lib/types';
import { MODEL_NAMES, recordId, type LedgerRecords, type ModelName } from './repository';

export const BACKUP_FORMAT = 'ledgerleaf-backup';
/** Version of the envelope; bump when its layout changes. Files from newer versions are refused. */
export const BACKUP_VERSION = 1;

/** Everything in the ledger that is not a store of records. */
export type BackupMeta = Pick<
  LedgerState, 'lastSync' | 'syncs' | 'importMappings' | 'recurring' | 'settings' | 'importBatches' | 'deletedTransactions'
>;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  /** Schema version of the records inside. */
  schemaVersion: number;
  /** ISO timestamp the backup was made. */
  exportedAt: string;
  stores: LedgerRecords;
  meta: BackupMeta;
}

export type RestoreMode = 'replace' | 'merge';

export type StoreCounts = Record<ModelName, number>;

export const STORE_LABELS: Record<ModelName, string> = {
  accounts: 'Accounts', transactions: 'Transactions', categories: 'Categories', rules: 'Rules', budgets: 'Budgets',
  balanceSnapshots: 'Balance history',
};

export function makeBackup(state: LedgerState, now = new Date()): Backup {
  const { lastSync, syncs, importMappings, recurring, settings, importBatches, deletedTransactions } = state;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    stores: Object.fromEntries(MODEL_NAMES.map((n) => [n, state[n]])) as LedgerRecords,
    meta: { lastSync, syncs, importMappings, recurring, settings, importBatches, deletedTransactions },
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const backupFilename = (now = new Date()) => `ledgerleaf-backup-${stamp(now)}.json`;
export const csvFilename = (now = new Date()) => `ledgerleaf-transactions-${stamp(now)}.csv`;

export const storeCounts = (stores: LedgerRecords): StoreCounts =>
  Object.fromEntries(MODEL_NAMES.map((n) => [n, stores[n].length])) as StoreCounts;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => typeof v === 'string' && v !== '';
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

/** Per store: a check for each record, returning what is wrong with it or undefined. */
const CHECKS: { [K in ModelName]: (r: Record<string, unknown>) => string | undefined } = {
  accounts: (r) => (!str(r.id) ? 'needs an id' : typeof r.name !== 'string' ? 'needs a name' : undefined),
  transactions: (r) =>
    !str(r.id) ? 'needs an id'
      : typeof r.date !== 'string' || !ISO_DATE.test(r.date) ? 'needs a YYYY-MM-DD date'
        : !num(r.amount) ? 'needs a numeric amount'
          : !str(r.accountId) ? 'needs an accountId'
            : typeof r.description !== 'string' ? 'needs a description' : undefined,
  categories: (r) => (!str(r.id) ? 'needs an id' : undefined),
  rules: (r) => (!str(r.id) ? 'needs an id' : !str(r.categoryId) ? 'needs a categoryId' : undefined),
  budgets: (r) =>
    !str(r.id) ? 'needs an id'
      : !str(r.categoryId) ? 'needs a categoryId'
        : typeof r.month !== 'string' || !MONTH.test(r.month) ? 'needs a YYYY-MM month'
          : !num(r.amount) ? 'needs a numeric amount' : undefined,
  balanceSnapshots: (r) =>
    !str(r.accountId) ? 'needs an accountId'
      : typeof r.date !== 'string' || !ISO_DATE.test(r.date) ? 'needs a YYYY-MM-DD date'
        : !num(r.balance) ? 'needs a numeric balance' : undefined,
};

export type ParseResult = { ok: true; backup: Backup; counts: StoreCounts } | { ok: false; error: string };

/** Read and validate a backup file's text. Nothing about the file is trusted until this says ok. */
export function parseBackup(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file is not valid JSON.' };
  }
  if (!isObject(raw) || raw.format !== BACKUP_FORMAT) return { ok: false, error: 'This is not a Ledgerleaf backup file.' };
  if (!Number.isInteger(raw.version) || (raw.version as number) < 1) return { ok: false, error: 'The backup has no valid version.' };
  if ((raw.version as number) > BACKUP_VERSION) {
    return { ok: false, error: `This backup was made by a newer version of Ledgerleaf (format ${raw.version}); update the app to restore it.` };
  }
  if (num(raw.schemaVersion) && (raw.schemaVersion as number) > SCHEMA_VERSION) {
    return { ok: false, error: `This backup uses a newer data schema (v${raw.schemaVersion}); update the app to restore it.` };
  }
  if (!isObject(raw.stores)) return { ok: false, error: 'The backup has no data stores.' };

  const stores = {} as Record<ModelName, unknown[]>;
  for (const name of MODEL_NAMES) {
    const list = raw.stores[name] ?? [];
    if (!Array.isArray(list)) return { ok: false, error: `${STORE_LABELS[name]} in the backup is not a list.` };
    const seen = new Set<string>();
    for (const [i, r] of list.entries()) {
      const problem = isObject(r) ? CHECKS[name](r) : 'is not an object';
      if (problem) return { ok: false, error: `${STORE_LABELS[name]} record ${i + 1} ${problem}.` };
      const id = recordId(name, r as never);
      if (seen.has(id)) return { ok: false, error: `${STORE_LABELS[name]} has two records with the key ${id}.` };
      seen.add(id);
    }
    stores[name] = list;
  }

  const meta = isObject(raw.meta) ? raw.meta : {};
  const backup: Backup = {
    format: BACKUP_FORMAT,
    version: raw.version as number,
    schemaVersion: num(raw.schemaVersion) ? (raw.schemaVersion as number) : SCHEMA_VERSION,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    stores: stores as LedgerRecords,
    meta: {
      lastSync: typeof meta.lastSync === 'string' ? meta.lastSync : undefined,
      syncs: isObject(meta.syncs) ? (meta.syncs as BackupMeta['syncs']) : undefined,
      importMappings: isObject(meta.importMappings) ? (meta.importMappings as BackupMeta['importMappings']) : undefined,
      recurring: isObject(meta.recurring) ? (meta.recurring as unknown as RecurringSettings) : undefined,
      settings: isObject(meta.settings) ? normalizeSettings(meta.settings) : undefined,
      importBatches: Array.isArray(meta.importBatches) ? (meta.importBatches as BackupMeta['importBatches']) : undefined,
      deletedTransactions: Array.isArray(meta.deletedTransactions)
        ? (meta.deletedTransactions as BackupMeta['deletedTransactions']) : undefined,
    },
  };
  return { ok: true, backup, counts: storeCounts(backup.stores) };
}

/** `current` followed by the `incoming` records whose key it does not already have. */
function mergeStore<K extends ModelName>(name: K, current: LedgerRecords[K], incoming: LedgerRecords[K]): LedgerRecords[K] {
  const have = new Set(current.map((v) => recordId(name, v as never)));
  const added = incoming.filter((v) => !have.has(recordId(name, v as never)));
  return (added.length ? [...current, ...added] : current) as LedgerRecords[K];
}

function mergeRecurring(a?: RecurringSettings, b?: RecurringSettings): RecurringSettings | undefined {
  if (!a || !b) return a ?? b;
  const ids = new Set(a.manual.map((m) => m.id));
  return { decisions: { ...b.decisions, ...a.decisions }, manual: [...a.manual, ...b.manual.filter((m) => !ids.has(m.id))] };
}

/** `a` followed by the batches of `b` it lacks, newest first. */
function mergeBatches(a: ImportBatch[] = [], b: ImportBatch[] = []): ImportBatch[] {
  const ids = new Set(a.map((x) => x.id));
  return [...a, ...b.filter((x) => !ids.has(x.id))].sort((x, y) => y.at.localeCompare(x.at));
}

/** Tombstones of both, except for transactions `current` holds (it wins). */
function mergeDeleted(current: LedgerState, b: DeletedTransaction[] = []): DeletedTransaction[] {
  const a = current.deletedTransactions ?? [];
  const skip = new Set([...current.transactions, ...a].map(dedupeKey));
  return [...a, ...b.filter((d) => !skip.has(dedupeKey(d)))];
}

export interface RestoreResult {
  state: LedgerState;
  /** Records taken from the backup, per store (in merge mode, those whose key was new). */
  added: StoreCounts;
}

/**
 * The ledger after restoring `backup`. `replace` makes it exactly the backup (settings too).
 * `merge` keeps everything in `current` and adds backup records whose key (id; account and
 * day for balance history) it lacks; where both have something, `current` wins, settings
 * included. A transaction in both keeps `current`'s record, `importBatchIds` too: claims are not
 * unioned, so undoing a backup's batch never deletes a row `current` did not attribute to it.
 * Deleted-transaction tombstones are unioned, so a backup never brings back a transaction
 * `current` deleted; a backup's tombstone of a transaction `current` holds is dropped. Either way the result is normalized like a freshly loaded ledger.
 */
export function restoreBackup(current: LedgerState, backup: Backup, mode: RestoreMode): RestoreResult {
  const { stores, meta } = backup;
  if (mode === 'replace') {
    const state = normalizeLedger({ ...stores, ...meta, version: SCHEMA_VERSION });
    return { state, added: storeCounts(stores) };
  }
  const deleted = new Set(current.deletedTransactions?.map(dedupeKey));
  const incoming = { ...stores, transactions: stores.transactions.filter((t) => !deleted.has(dedupeKey(t))) };
  const merged = Object.fromEntries(MODEL_NAMES.map((n) => [n, mergeStore(n, current[n], incoming[n])])) as LedgerRecords;
  const added = Object.fromEntries(MODEL_NAMES.map((n) => [n, merged[n].length - current[n].length])) as StoreCounts;
  const lastSync = [current.lastSync, meta.lastSync].filter(Boolean).sort().at(-1);
  const state = normalizeLedger({
    ...merged,
    version: SCHEMA_VERSION,
    lastSync,
    syncs: { ...meta.syncs, ...current.syncs },
    importMappings: { ...meta.importMappings, ...current.importMappings },
    recurring: mergeRecurring(current.recurring, meta.recurring),
    settings: current.settings ?? meta.settings,
    importBatches: mergeBatches(current.importBatches, meta.importBatches),
    deletedTransactions: mergeDeleted(current, meta.deletedTransactions),
  });
  return { state, added };
}
