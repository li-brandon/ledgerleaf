import type { LedgerState } from '../lib/types';
import { saveLedger } from './ledger';
import type { Repository } from './repository';

/**
 * Whether everything handed to the persister is stored. `saving` while a write is queued or
 * in flight; `failed` once the last background write rejected and nothing newer is queued.
 */
export type SaveStatus = { state: 'saved' } | { state: 'saving' } | { state: 'failed'; error: unknown };

export interface Persister {
  /** Queue `state` to be written after `delay` ms of quiet. */
  schedule(state: LedgerState): void;
  /** Write any queued state now; resolves once everything scheduled so far is stored. */
  flush(): Promise<void>;
  /**
   * Write `state` now, after anything already queued, superseding a pending schedule.
   * Rejects if the write fails; the repository applies it atomically, so nothing is stored then.
   */
  commit(state: LedgerState): Promise<void>;
  /** After a failed save, write the latest state again now; otherwise the same as {@link flush}. */
  retry(): Promise<void>;
}

const errorOf = (s: SaveStatus) => (s.state === 'failed' ? s.error : undefined);

/**
 * Debounced, serialised writer. Each save diffs against the last state that was
 * written, so typical edits touch a handful of records rather than the whole ledger.
 * A failed write leaves that base alone, so the next write includes everything unsaved.
 */
export function createPersister(
  repo: Repository, saved: LedgerState, delay = 250, onError: (e: unknown) => void = console.error,
  onStatus: (status: SaveStatus) => void = () => {},
): Persister {
  let pending: LedgerState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain = Promise.resolve();
  /** The newest state handed over; everything is saved once it is. */
  let latest = saved;
  let writes = 0;
  /** Why the last background write failed; cleared by any successful write. */
  let failure: { error: unknown } | undefined;
  let status: SaveStatus = { state: 'saved' };

  const idle = () => !writes && (pending === undefined || pending === saved);

  function report() {
    const next: SaveStatus = !idle() ? { state: 'saving' }
      : latest === saved ? { state: 'saved' }
      : failure ? { state: 'failed', error: failure.error }
      // A failed commit superseded a queued state; the caller queues it again.
      : { state: 'saving' };
    if (next.state === status.state && errorOf(next) === errorOf(status)) return;
    status = next;
    onStatus(next);
  }

  /** Queue a write. The chain itself never rejects; `report` sees failures there. */
  function save(next: LedgerState, onFail?: (e: unknown) => void) {
    writes++;
    const done = chain.then(async () => {
      if (next === saved) return;
      await saveLedger(repo, next, saved);
      saved = next;
      failure = undefined;
    }).finally(() => {
      writes--;
    });
    chain = done.catch((e) => onFail?.(e)).finally(report);
    return done;
  }

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    const next = pending;
    pending = undefined;
    if (next && next !== saved) {
      void save(next, (e) => {
        failure = { error: e };
        onError(e);
      });
    }
    report();
    return chain;
  }

  return {
    schedule(state) {
      pending = latest = state;
      clearTimeout(timer);
      timer = setTimeout(flush, delay);
      report();
    },
    flush,
    commit(state) {
      clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      const before = latest;
      latest = state;
      const done = save(state, () => {
        // The caller reports this failure; a retry must not write the rejected state.
        if (latest === state) latest = before;
      });
      report();
      return done;
    },
    retry() {
      if (idle()) pending = latest;
      return flush();
    },
  };
}
