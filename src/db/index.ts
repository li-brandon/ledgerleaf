import { openIdbRepository, type OpenOptions } from './indexeddb';
import { createMemoryRepository } from './memory';
import type { Repository } from './repository';

export * from './repository';
export { DB_NAME, DB_VERSION, openIdbRepository, type OpenOptions } from './indexeddb';
export { createMemoryRepository } from './memory';
export { LEGACY_KEYS, diffLedger, loadLedger, readLedger, saveLedger } from './ledger';
export { createPersister, type Persister, type SaveStatus } from './persister';
export { clearDemoData, demoCounts, hasDemoData, withoutDemo, type DemoCounts } from './demo';

/** The app's repository: IndexedDB, or an in-memory stand-in (data lost on reload) where it is unavailable. */
export async function openRepository(options?: OpenOptions): Promise<Repository> {
  try {
    return await openIdbRepository(undefined, options);
  } catch (e) {
    console.warn('IndexedDB unavailable; changes will not persist across reloads.', e);
    return createMemoryRepository();
  }
}
