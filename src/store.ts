import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createPersister, demoCounts, loadLedger, openRepository, withoutDemo, type Persister, type Repository,
} from './db';
import { renameAccount, setAccountHidden } from './lib/accounts';
import { currentMonth, setMonthBudget } from './lib/budget';
import {
  addCategory as addCat, deleteCategory as deleteCat, ensureCategory, updateCategory as updateCat, type CategoryDraft,
} from './lib/categories';
import { emptyLedger } from './lib/migrate';
import { applyRulesToLedger, moveRule as moveRuleIn, removeRule, upsertRule, type ApplyOptions } from './lib/rules';
import { SyncError, applySync, fetchSync, type SyncProvider } from './lib/sync';
import {
  addMerchantRule, editTransaction, removeMerchantRule, setCategory as setTxCategory, setReviewed as setTxReviewed,
  type TxEdit,
} from './lib/txEdits';
import type { LedgerState, Rule } from './lib/types';

export type { LedgerState };

/**
 * The ledger, loaded asynchronously from the repository (IndexedDB by default). `state` is
 * an empty placeholder while `loading`; afterwards every change is persisted in the
 * background, debounced and diffed against the last save.
 */
export function useLedger(open: () => Promise<Repository> = openRepository) {
  const [state, setState] = useState<LedgerState>(emptyLedger);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(state);
  const persister = useRef<Persister | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let repo: Repository | undefined;
    let saver: Persister | undefined;
    const flush = () => void saver?.flush();
    const onVisibility = () => document.visibilityState === 'hidden' && flush();

    (async () => {
      repo = await open();
      const loaded = !cancelled && (await loadLedger(repo));
      if (cancelled || !loaded) return repo.close();
      saver = persister.current = createPersister(repo, loaded);
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
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      if (persister.current === saver) persister.current = undefined;
      const r = repo;
      if (saver && r) void saver.flush().then(() => r.close());
    };
  }, [open]);

  useEffect(() => {
    latest.current = state;
    persister.current?.schedule(state);
  }, [state]);

  /**
   * Sync one provider, all or nothing: everything is fetched and validated, merged, and
   * written to storage before the ledger updates. Any failure throws a {@link SyncError}
   * and leaves both the stored and in-memory ledger untouched. `also` makes further changes
   * to the synced ledger that are saved in the same write, e.g. remembering a CSV mapping.
   */
  const runSync = useCallback(async (provider: SyncProvider, also: (s: LedgerState) => LedgerState = (s) => s) => {
    const incoming = await fetchSync(provider, latest.current);
    const now = new Date();
    const prev = latest.current;
    const sync = (s: LedgerState) => also(applySync(s, provider.id, incoming, now).state);
    const outcome = applySync(prev, provider.id, incoming, now);
    const next = also(outcome.state);
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
    const { added, updated, received } = outcome;
    return { added, updated, received };
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

  const reset = useCallback(() => setState(emptyLedger()), []);

  return {
    state, loading, error, runSync, clearDemo, setCategory, setAlways, setReviewed, editTransaction: editTx, setBudget, setRollover, renameAccount: renameAcct,
    setAccountHidden: setHidden, addCategory, updateCategory, deleteCategory, saveRule, deleteRule, moveRule, applyRules,
    reset,
  };
}

export type Ledger = ReturnType<typeof useLedger>;
