import { openIdbRepository } from './indexeddb';
import { createMemoryRepository } from './memory';
import type { Repository } from './repository';

export * from './repository';
export { DB_NAME, openIdbRepository } from './indexeddb';
export { createMemoryRepository } from './memory';
export { LEGACY_KEYS, diffLedger, loadLedger, readLedger, saveLedger } from './ledger';
export { createPersister, type Persister } from './persister';
export { clearDemoData, demoCounts, hasDemoData, withoutDemo, type DemoCounts } from './demo';

/** The app's repository: IndexedDB, or an in-memory stand-in (data lost on reload) where it is unavailable. */
export async function openRepository(): Promise<Repository> {
  try {
    return await openIdbRepository();
  } catch (e) {
    console.warn('IndexedDB unavailable; changes will not persist across reloads.', e);
    return createMemoryRepository();
  }
}
