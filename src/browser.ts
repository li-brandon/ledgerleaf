/** Small browser-only helpers (downloads, per-tab memory). Nothing here touches the network. */
import { EMPTY_FILTERS, filtersToParams, parseFilters, type TxFilters } from './lib/txFilters';

/** Save `text` as a file via a temporary object URL. */
export function downloadFile(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

const FILTERS_KEY = 'ledgerleaf:txFilters';

/** Remember the Transactions filters for this tab, so Settings can export the same rows. */
export function rememberTxFilters(f: TxFilters) {
  try { sessionStorage.setItem(FILTERS_KEY, JSON.stringify(filtersToParams(f))); } catch { /* storage unavailable */ }
}

/** The filters last used on Transactions in this tab; none set if it was never opened. */
export function rememberedTxFilters(): TxFilters {
  try {
    const raw = JSON.parse(sessionStorage.getItem(FILTERS_KEY) ?? '{}');
    return typeof raw === 'object' && raw ? parseFilters(raw) : EMPTY_FILTERS;
  } catch {
    return EMPTY_FILTERS;
  }
}

/**
 * Whether the browser keeps this origin's data (IndexedDB included) under storage pressure.
 * `unsupported` covers browsers without the Storage API and ones whose check fails.
 */
export type StoragePersistence = 'persistent' | 'best-effort' | 'unsupported';

const storageManager = (): Partial<StorageManager> | undefined => globalThis.navigator?.storage;

export async function persistenceStatus(storage = storageManager()): Promise<StoragePersistence> {
  if (typeof storage?.persisted !== 'function' || typeof storage.persist !== 'function') return 'unsupported';
  try {
    return (await storage.persisted()) ? 'persistent' : 'best-effort';
  } catch {
    return 'unsupported';
  }
}

/**
 * Ask the browser to keep this origin's data, unless it already does. Firefox prompts for this;
 * Chrome decides by itself. A failed request leaves the data best effort. Never rejects.
 */
export async function requestPersistence(storage = storageManager()): Promise<StoragePersistence> {
  const status = await persistenceStatus(storage);
  if (status !== 'best-effort') return status;
  try {
    return (await storage!.persist!()) ? 'persistent' : 'best-effort';
  } catch {
    return 'best-effort';
  }
}

let persistenceRequested = false;

/** {@link requestPersistence}, at most once per page load, so a refusal is not asked again on every import. */
export function requestPersistenceOnce() {
  if (persistenceRequested) return;
  persistenceRequested = true;
  void requestPersistence();
}

/** For tests: let {@link requestPersistenceOnce} ask again. */
export function forgetPersistenceRequest() {
  persistenceRequested = false;
}
