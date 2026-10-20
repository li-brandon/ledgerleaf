import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createPersister, demoCounts, loadLedger, openRepository, withoutDemo, type Persister, type Repository,
} from './db';
import { renameAccount, setAccountHidden } from './lib/accounts';
import { currentMonth, upsertBudget } from './lib/budget';
import { ensureCategory } from './lib/categories';
import { emptyLedger } from './lib/migrate';
import { SyncError, applySync, fetchSync, type SyncProvider } from './lib/sync';
import type { LedgerState } from './lib/types';

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

  const setCategory = useCallback((id: string, category: string) =>
    setState((s) => {
      const categories = [...s.categories];
      const cat = ensureCategory(categories, category);
      const transactions = s.transactions.map((t) => (t.id === id ? { ...t, category: cat.name, categoryId: cat.id } : t));
      return { ...s, categories, transactions };
    }), []);

  const setReviewed = useCallback((id: string, reviewed: boolean) =>
    setState((s) => ({ ...s, transactions: s.transactions.map((t) => (t.id === id ? { ...t, reviewed } : t)) })), []);

  const setBudget = useCallback((category: string, amount: number) =>
    setState((s) => {
      const categories = [...s.categories];
      const cat = ensureCategory(categories, category);
      return { ...s, categories, budgets: upsertBudget(s.budgets, cat.id, currentMonth(), Math.max(0, amount || 0)) };
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

  const reset = useCallback(() => setState(emptyLedger()), []);

  return {
    state, loading, error, runSync, clearDemo, setCategory, setReviewed, setBudget, renameAccount: renameAcct,
    setAccountHidden: setHidden, reset,
  };
}

export type Ledger = ReturnType<typeof useLedger>;
