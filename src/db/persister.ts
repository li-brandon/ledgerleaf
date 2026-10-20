import type { LedgerState } from '../lib/types';
import { saveLedger } from './ledger';
import type { Repository } from './repository';

export interface Persister {
  /** Queue `state` to be written after `delay` ms of quiet. */
  schedule(state: LedgerState): void;
  /** Write any queued state now; resolves once everything scheduled so far is stored. */
  flush(): Promise<void>;
}

/**
 * Debounced, serialised writer. Each save diffs against the last state that was
 * written, so typical edits touch a handful of records rather than the whole ledger.
 */
export function createPersister(
  repo: Repository, saved: LedgerState, delay = 250, onError: (e: unknown) => void = console.error,
): Persister {
  let pending: LedgerState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain = Promise.resolve();

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    const next = pending;
    pending = undefined;
    if (next && next !== saved) {
      chain = chain.then(async () => {
        try {
          await saveLedger(repo, next, saved);
          saved = next;
        } catch (e) {
          onError(e);
        }
      });
    }
    return chain;
  }

  return {
    schedule(state) {
      pending = state;
      clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    flush,
  };
}
