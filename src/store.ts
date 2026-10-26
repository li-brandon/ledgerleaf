import { useCallback, useEffect, useRef, useState } from 'react';
import { requestPersistenceOnce } from './browser';
import {
  DB_NAME, createPersister, demoCounts, loadLedger, openRepository, readLedger, withoutDemo, type OpenOptions,
  type Persister, type Repository, type SaveStatus,
} from './db';
import { restoreBackup, type Backup, type RestoreMode } from './db/backup';
import { renameAccount, setAccountHidden } from './lib/accounts';
import { currentMonth, setMonthBudget } from './lib/budget';
import {
  addCategory as addCat, deleteCategory as deleteCat, ensureCategory, updateCategory as updateCat, type CategoryDraft,
} from './lib/categories';
import { undoImport as undoImportIn } from './lib/importBatches';
import { emptyLedger } from './lib/migrate';
import {
  addManualRecurring, removeManualRecurring, setRecurringDecision, type ManualDraft,
} from './lib/recurring';
import { applyRulesToLedger, moveRule as moveRuleIn, removeRule, upsertRule, type ApplyOptions } from './lib/rules';
import { settingsOf, updateSettings, type Settings } from './lib/settings';
import { SyncError, applySync, fetchSync, type SyncProvider } from './lib/sync';
import {
  addMerchantRule, deleteTransaction as deleteTx, editTransaction, removeMerchantRule, restoreTransaction as restoreTx,
  setCategory as setTxCategory, setReviewed as setTxReviewed, type TxEdit,
} from './lib/txEdits';
import type { LedgerState, RecurringDecision, Rule, Transaction } from './lib/types';

export type { LedgerState };

/**
 * The ledger, loaded asynchronously from the repository (IndexedDB by default). `state` is
 * an empty placeholder while `loading`; afterwards every change is persisted in the
 * background, debounced and diffed against the last save. Other tabs are told of each save over a
 * BroadcastChannel and read the ledger again.
 */
export function useLedger(open: (options: OpenOptions) => Promise<Repository> = openRepository) {
  const [state, setState] = useState<LedgerState>(emptyLedger);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Why the last save failed; kept until a save succeeds, so it survives retries and new edits. */
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Opening waits for older tabs to close so the database can be upgraded. */
  const [blocked, setBlocked] = useState(false);
  /** Another tab upgraded the database; this tab's connection is closed and it must reload. */
  const [stale, setStale] = useState(false);
  const latest = useRef(state);
  const persister = useRef<Persister | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let repo: Repository | undefined;
    let saver: Persister | undefined;
    let status: SaveStatus = { state: 'saved' };
    let channel: BroadcastChannel | undefined;
    let closed = false;
    /** Another tab saved while this one had unsaved changes; read the ledger again once they are saved. */
    let behind = false;
    const flush = () => void saver?.flush();
    const onVisibility = () => document.visibilityState === 'hidden' && flush();
    const onStatus = (s: SaveStatus) => {
      status = s;
      if (cancelled) return;
      if (s.state === 'failed') setSaveError(messageOf(s.error));
      else if (s.state === 'saved') setSaveError(null);
      if (s.state === 'saved' && behind) void refresh();
    };
    /**
     * Show what another tab stored. Unsaved changes here are saved first (on top of the other
     * tab's, record by record and meta key by meta key) rather than dropped, then this runs again.
     */
    async function refresh() {
      if (cancelled || closed || !repo || !saver) return;
      if (status.state !== 'saved') return void (behind = true);
      behind = false;
      const base = latest.current;
      const loaded = await readLedger(repo);
      if (cancelled || closed || !loaded) return;
      // Edited while reading: the edit's save brings us back here.
      if (latest.current !== base || status.state !== 'saved') return void (behind = true);
      saver.reset(loaded);
      latest.current = loaded;
      setState(loaded);
    }
    const options: OpenOptions = {
      onBlocked: () => setBlocked(true),
      onBlocking() {
        closed = true;
        setStale(true);
        return saver?.flush();
      },
    };
    /** Unsaved changes are only in memory: ask before the tab closes, and try once more to save them. */
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!saver || status.state === 'saved') return;
      void saver.retry();
      e.preventDefault();
      e.returnValue = '';
    };

    (async () => {
      repo = await open(options);
      setBlocked(false);
      const loaded = !cancelled && (await loadLedger(repo));
      if (cancelled || !loaded) return repo.close();
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(DB_NAME);
        channel.onmessage = () => void refresh().catch(console.error);
      }
      const onSaved = () => channel?.postMessage({ type: 'changed' });
      saver = persister.current = createPersister(repo, loaded, undefined, undefined, onStatus, onSaved);
      latest.current = loaded;
      setState(loaded);
      setLoading(false);
    })().catch((e) => {
      console.error(e);
      if (cancelled) return;
      setError('Could not open local storage. Changes will not be saved.');
      setLoading(false);
    });
    addEventListener('pagehide', flush);
    addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      removeEventListener('pagehide', flush);
      removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibility);
      if (persister.current === saver) persister.current = undefined;
      // The last save is still announced; the load closes the repository itself if it is not done.
      if (saver) {
        void saver.flush().then(() => {
          channel?.close();
          repo?.close();
        });
      }
    };
  }, [open]);

  useEffect(() => {
    latest.current = state;
    persister.current?.schedule(state);
  }, [state]);

  /** Write the latest ledger again now, after a background save failed. */
  const retrySave = useCallback(() => void persister.current?.retry(), []);

  /**
   * Sync one provider, all or nothing: everything is fetched and validated, merged, and
   * written to storage before the ledger updates. Any failure throws a {@link SyncError}
   * and leaves both the stored and in-memory ledger untouched. `also` makes further changes
   * to the synced ledger that are saved in the same write, e.g. remembering a CSV mapping; it
   * also gets the ledger the sync was merged into. The first sync of a session that adds real
   * data also asks the browser to make storage persistent.
   */
  const runSync = useCallback(async (
    provider: SyncProvider, also: (s: LedgerState, before: LedgerState) => LedgerState = (s) => s,
  ) => {
    const incoming = await fetchSync(provider, latest.current);
    const now = new Date();
    const prev = latest.current;
    const sync = (s: LedgerState) => also(applySync(s, provider.id, incoming, now).state, s);
    const outcome = applySync(prev, provider.id, incoming, now);
    const next = also(outcome.state, prev);
    try {
      await persister.current?.commit(next);
    } catch (e) {
      // The commit replaced any queued save; queue the current ledger again.
      persister.current?.schedule(latest.current);
      throw new SyncError(provider.id, `${provider.name} could not be saved; nothing was imported.`, { cause: e });
    }
    // Edits made while the sync was being written are kept by merging into them instead.
    const merge = (s: LedgerState) => (s === prev ? next : sync(s));
    latest.current = merge(latest.current);
    setState(merge);
    const { added, updated, removed, received } = outcome;
    // Real data is now stored: ask the browser not to evict it (sample data is not worth a prompt).
    if (added && provider.kind !== 'demo') requestPersistenceOnce();
    return { added, updated, removed, received };
  }, []);

  /**
   * Remove demo accounts, transactions and balance snapshots, leaving imported data alone.
   * Written to storage in one transaction before the ledger updates; throws and changes
   * nothing if the write fails. Resolves to how much was removed.
   */
  const clearDemo = useCallback(async () => {
    const prev = latest.current;
    const removed = demoCounts(prev);
    const next = withoutDemo(prev);
    if (next === prev) return removed;
    try {
      await persister.current?.commit(next);
    } catch (e) {
      persister.current?.schedule(latest.current);
      throw new Error('Demo data could not be removed; nothing was changed.', { cause: e });
    }
    const merge = (s: LedgerState) => (s === prev ? next : withoutDemo(s));
    latest.current = merge(latest.current);
    setState(merge);
    return removed;
  }, []);

  /**
   * Undo a CSV import: remove its transactions and what it created (see `lib/importBatches`).
   * Written to storage before the ledger updates; throws and changes nothing if the write
   * fails. Resolves to how many transactions were removed.
   */
  const undoImport = useCallback(async (batchId: string) => {
    const prev = latest.current;
    const next = undoImportIn(prev, batchId);
    const removed = prev.transactions.length - next.transactions.length;
    if (next === prev) return removed;
    try {
      await persister.current?.commit(next);
    } catch (e) {
      persister.current?.schedule(latest.current);
      throw new Error('The import could not be undone; nothing was changed.', { cause: e });
    }
    const merge = (s: LedgerState) => (s === prev ? next : undoImportIn(s, batchId));
    latest.current = merge(latest.current);
    setState(merge);
    return removed;
  }, []);

  /**
   * Write `change` of the latest ledger to storage, then show it; edits made meanwhile get
   * `change` applied on top. Throws `failure` and changes nothing if the write fails.
   */
  const commitChange = useCallback(async (change: (s: LedgerState) => LedgerState, failure: string) => {
    const prev = latest.current;
    const next = change(prev);
    if (next === prev) return prev;
    try {
      await persister.current?.commit(next);
    } catch (e) {
      persister.current?.schedule(latest.current);
      throw new Error(failure, { cause: e });
    }
    const merge = (s: LedgerState) => (s === prev ? next : change(s));
    latest.current = merge(latest.current);
    setState(merge);
    return prev;
  }, []);

  /**
   * Delete one transaction, remembering it so re-syncs and re-imports leave it out (see
   * `lib/txEdits`). Written to storage before the ledger updates; throws and changes nothing if
   * the write fails. Resolves to the deleted transaction, for {@link restoreTransaction}.
   */
  const deleteTransaction = useCallback(async (id: string) => {
    const prev = await commitChange((s) => deleteTx(s, id), 'The transaction could not be deleted; nothing was changed.');
    return prev.transactions.find((t) => t.id === id);
  }, [commitChange]);

  /**
   * Undo {@link deleteTransaction}, against the latest ledger; saved the same way. Resolves to
   * false when the row could not be put back (its imports were undone or its account removed).
   */
  const restoreTransaction = useCallback(async (t: Transaction) => {
    await commitChange((s) => restoreTx(s, t), 'The transaction could not be restored; nothing was changed.');
    return latest.current.transactions.some((x) => x.id === t.id);
  }, [commitChange]);

  /** Set the category of one or more transactions; `always` also makes it the rule for the first one's merchant. */
  const setCategory = useCallback((ids: string | string[], category: string, opts: { always?: boolean } = {}) =>
    setState((s) => {
      const list = typeof ids === 'string' ? [ids] : ids;
      const next = setTxCategory(s, list, category);
      return opts.always && list.length ? addMerchantRule(next, list[0], category) : next;
    }), []);

  /** Turn "always categorize like this" on (with the transaction's current category) or off for its merchant. */
  const setAlways = useCallback((id: string, on: boolean) =>
    setState((s) => {
      const t = s.transactions.find((x) => x.id === id);
      if (!t) return s;
      return on ? addMerchantRule(s, id, t.category) : removeMerchantRule(s, id);
    }), []);

  const setReviewed = useCallback((ids: string | string[], reviewed: boolean) =>
    setState((s) => setTxReviewed(s, typeof ids === 'string' ? [ids] : ids, reviewed)), []);

  const editTx = useCallback((id: string, edit: TxEdit) => setState((s) => editTransaction(s, id, edit)), []);

  /** Set a category's budget (by name) for `month` and the months after it that have none of their own. */
  const setBudget = useCallback((category: string, amount: number, month = currentMonth()) =>
    setState((s) => {
      const categories = [...s.categories];
      const cat = ensureCategory(categories, category);
      return { ...s, categories, budgets: setMonthBudget(s.budgets, cat.id, month, { amount: Math.max(0, amount || 0) }) };
    }), []);

  /** Turn rollover on or off for a category (by name) from `month` on. */
  const setRollover = useCallback((category: string, rollover: boolean, month = currentMonth()) =>
    setState((s) => {
      const categories = [...s.categories];
      const cat = ensureCategory(categories, category);
      return { ...s, categories, budgets: setMonthBudget(s.budgets, cat.id, month, { rollover }) };
    }), []);

  const renameAcct = useCallback((id: string, name: string) =>
    setState((s) => {
      const accounts = renameAccount(s.accounts, id, name);
      return accounts === s.accounts ? s : { ...s, accounts };
    }), []);

  const setHidden = useCallback((id: string, hidden: boolean) =>
    setState((s) => {
      const accounts = setAccountHidden(s.accounts, id, hidden);
      return accounts === s.accounts ? s : { ...s, accounts };
    }), []);

  /**
   * Apply a change that may throw (e.g. a duplicate category name). It is checked against
   * the latest ledger first; resolves to the error message, or undefined once applied.
   */
  const attempt = useCallback((fn: (s: LedgerState) => LedgerState): string | undefined => {
    try {
      fn(latest.current);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    setState((s) => {
      try {
        return fn(s);
      } catch {
        return s;
      }
    });
    return undefined;
  }, []);

  const addCategory = useCallback((draft: CategoryDraft) => attempt((s) => addCat(s, draft)), [attempt]);
  const updateCategory = useCallback((id: string, draft: CategoryDraft) => attempt((s) => updateCat(s, id, draft)), [attempt]);
  /** Delete a category, moving anything that uses it to `reassignTo`. */
  const deleteCategory = useCallback((id: string, reassignTo?: string) => attempt((s) => deleteCat(s, id, reassignTo)), [attempt]);

  /** Add a rule (lowest priority) or replace the one with its id. */
  const saveRule = useCallback((rule: Rule) => setState((s) => ({ ...s, rules: upsertRule(s.rules, rule) })), []);
  const deleteRule = useCallback((id: string) => setState((s) => ({ ...s, rules: removeRule(s.rules, id) })), []);
  /** Move a rule up (`by < 0`, higher priority) or down. */
  const moveRule = useCallback((id: string, by: number) =>
    setState((s) => {
      const rules = moveRuleIn(s.rules, id, by);
      return rules === s.rules ? s : { ...s, rules };
    }), []);
  /** Apply every rule to existing transactions, leaving fields the user edited alone. */
  const applyRules = useCallback((opts: ApplyOptions = {}) => setState((s) => applyRulesToLedger(s, opts)), []);

  /** Confirm or dismiss a detected recurring series; `undefined` makes it a suggestion again. */
  const setRecurring = useCallback((key: string, decision: RecurringDecision | undefined) =>
    setState((s) => setRecurringDecision(s, key, decision)), []);
  /** Add a recurring charge by hand; resolves to an error message if the draft is invalid. */
  const addRecurring = useCallback((draft: ManualDraft) => attempt((s) => addManualRecurring(s, draft)), [attempt]);
  const removeRecurring = useCallback((id: string) => setState((s) => removeManualRecurring(s, id)), []);

  /** Change settings; invalid values are ignored. */
  const setSettings = useCallback((patch: Partial<Settings>) =>
    setState((s) => ({ ...s, settings: updateSettings(settingsOf(s), patch) })), []);

  /**
   * Replace the whole ledger with `next`, written to storage before the ledger updates.
   * Throws `failure` and changes nothing if the write fails.
   */
  const replaceAll = useCallback(async (next: LedgerState, failure: string) => {
    try {
      await persister.current?.commit(next);
    } catch (e) {
      persister.current?.schedule(latest.current);
      throw new Error(failure, { cause: e });
    }
    latest.current = next;
    setState(next);
  }, []);

  /** Restore a parsed backup (see `db/backup`), replacing or merging into the ledger. Resolves to what was added. */
  const importBackup = useCallback(async (backup: Backup, mode: RestoreMode) => {
    const { state: next, added } = restoreBackup(latest.current, backup, mode);
    await replaceAll(next, 'The backup could not be saved; nothing was changed.');
    return added;
  }, [replaceAll]);

  /** Erase everything, settings included, leaving a fresh ledger. */
  const reset = useCallback(() => replaceAll(emptyLedger(), 'Local data could not be erased; nothing was changed.'), [replaceAll]);

  return {
    state, loading, error, saveError, blocked, stale, retrySave, runSync, clearDemo, undoImport, deleteTransaction, restoreTransaction, setCategory, setAlways, setReviewed, editTransaction: editTx, setBudget, setRollover, renameAccount: renameAcct,
    setAccountHidden: setHidden, addCategory, updateCategory, deleteCategory, saveRule, deleteRule, moveRule, applyRules,
    setRecurring, addRecurring, removeRecurring, setSettings, importBackup, reset,
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error || e instanceof DOMException ? e.message : String(e);
}

export type Ledger = ReturnType<typeof useLedger>;
