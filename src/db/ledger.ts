import { V1_KEY, V2_KEY, emptyLedger, migrate } from '../lib/migrate';
import { SCHEMA_VERSION, type LedgerState } from '../lib/types';
import {
  MODEL_NAMES, keyOf, recordId, type LedgerChanges, type LedgerRecords, type Meta, type ModelName, type Models,
  type Repository,
} from './repository';

/** The localStorage keys used before IndexedDB; read once by {@link loadLedger}, then removed. */
export const LEGACY_KEYS = [V2_KEY, V1_KEY] as const;

export type LegacyStorage = Pick<Storage, 'getItem' | 'removeItem'>;

const defaultStorage = (): LegacyStorage | undefined =>
  typeof localStorage === 'undefined' ? undefined : localStorage;

/** Read the stored ledger, or undefined if the database has never been written. */
export async function readLedger(repo: Repository): Promise<LedgerState | undefined> {
  const { records, meta } = await repo.readAll();
  if (meta.version === undefined) return undefined;
  return migrate({
    ...inLedgerOrder(records, meta.order), version: meta.version, lastSync: meta.lastSync, syncs: meta.syncs,
    importMappings: meta.importMappings, recurring: meta.recurring, settings: meta.settings,
    importBatches: meta.importBatches,
  });
}

function inLedgerOrder(records: LedgerRecords, order: Meta['order'] = {}): LedgerRecords {
  const out = { ...records };
  for (const name of MODEL_NAMES) {
    const ids = order[name];
    if (!ids) continue;
    const rank = new Map(ids.map((id, i) => [id, i]));
    const at = (v: unknown) => rank.get(recordId(name, v as never)) ?? Infinity;
    (out[name] as unknown[]) = [...records[name]].sort((a, b) => at(a) - at(b));
  }
  return out;
}

/** Meta keys held in the ledger state; compared by reference, as state updates are immutable. */
const STATE_META = ['lastSync', 'syncs', 'importMappings', 'recurring', 'settings', 'importBatches'] as const;

/**
 * The writes that turn `prev` into `next`. Without `prev` everything is replaced. With it,
 * meta holds only the keys that changed (plus `version`), so tabs saving different keys
 * don't overwrite each other.
 */
export function diffLedger(next: LedgerState, prev?: LedgerState): LedgerChanges {
  const order = Object.fromEntries(MODEL_NAMES.map((n) => [n, next[n].map((v) => recordId(n, v as never))]));
  const meta: Partial<Meta> = {
    version: SCHEMA_VERSION,
    ...Object.fromEntries(STATE_META.filter((k) => !prev || next[k] !== prev[k]).map((k) => [k, next[k]])),
  };
  if (!prev) return { clear: true, put: Object.fromEntries(MODEL_NAMES.map((n) => [n, next[n]])), meta: { ...meta, order } };

  const changes: Required<Pick<LedgerChanges, 'put' | 'delete'>> = { put: {}, delete: {} };
  for (const name of MODEL_NAMES) diffStore(name, next[name], prev[name], changes);
  // Order is rebuilt every time, so compare it by content. One key holds every store's order.
  const reordered = MODEL_NAMES.some((n) => next[n] !== prev[n]
    && (next[n].length !== prev[n].length || prev[n].some((v, i) => recordId(n, v as never) !== order[n][i])));
  return { ...changes, meta: reordered ? { ...meta, order } : meta };
}

/** State updates are immutable, so a record whose reference is unchanged is unchanged. */
function diffStore<K extends ModelName>(
  name: K,
  next: Models[K]['value'][],
  prev: Models[K]['value'][],
  out: Required<Pick<LedgerChanges, 'put' | 'delete'>>,
) {
  if (next === prev) return;
  const key = keyOf[name] as (v: Models[K]['value']) => Models[K]['key'];
  const id = (v: Models[K]['value']) => recordId(name, v);
  const before = new Map(prev.map((v) => [id(v), v]));
  const puts = next.filter((v) => before.get(id(v)) !== v);
  const kept = new Set(next.map(id));
  const deletes = prev.filter((v) => !kept.has(id(v))).map(key);
  if (puts.length) (out.put as Record<K, unknown>)[name] = puts;
  if (deletes.length) (out.delete as Record<K, unknown>)[name] = deletes;
}

/** Persist `next` in one transaction, writing only what changed since `prev` when given. */
export async function saveLedger(repo: Repository, next: LedgerState, prev?: LedgerState): Promise<void> {
  await repo.apply(diffLedger(next, prev));
}

/**
 * Load the ledger. On first run (empty database) a localStorage save from before the
 * IndexedDB move is migrated, written to the repository and removed from localStorage;
 * with nothing to migrate a fresh ledger is written instead. If another load (a second
 * tab, or a re-run effect) initialises the database first, its ledger wins.
 */
export async function loadLedger(repo: Repository, storage = defaultStorage()): Promise<LedgerState> {
  const stored = await readLedger(repo);
  if (stored) return stored;

  const legacy = readLegacy(storage);
  const state = legacy.found ? migrate(legacy.value) : emptyLedger();
  if (!(await repo.apply(diffLedger(state), { ifEmpty: true }))) return (await readLedger(repo))!;
  if (legacy.found) for (const k of LEGACY_KEYS) storage?.removeItem(k);
  return state;
}

function readLegacy(storage: LegacyStorage | undefined): { found: false } | { found: true; value: unknown } {
  const raw = storage && LEGACY_KEYS.map((k) => storage.getItem(k)).find((v) => v !== null);
  if (raw == null) return { found: false };
  try {
    return { found: true, value: JSON.parse(raw) };
  } catch {
    // Unreadable save: start fresh but leave the keys alone rather than destroy them.
    return { found: false };
  }
}
