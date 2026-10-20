import { useCallback, useEffect, useRef, useState } from 'react';
import { createPersister, loadLedger, openRepository, type Persister, type Repository } from './db';
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
   * and leaves both the stored and in-memory ledger untouched.
   */
  const runSync = useCallback(async (provider: SyncProvider) => {
    const incoming = await fetchSync(provider, latest.current);
    const now = new Date();
    const prev = latest.current;
    const outcome = applySync(prev, provider.id, incoming, now);
    try {
      await persister.current?.commit(outcome.state);
    } catch (e) {
      // The commit replaced any queued save; queue the current ledger again.
      persister.current?.schedule(latest.current);
      throw new SyncError(provider.id, `${provider.name} could not be saved; nothing was imported.`, { cause: e });
    }
    // Edits made while the sync was being written are kept by merging into them instead.
    const merge = (s: LedgerState) => (s === prev ? outcome.state : applySync(s, provider.id, incoming, now).state);
    latest.current = merge(latest.current);
    setState(merge);
    const { added, updated, received } = outcome;
    return { added, updated, received };
  }, []);

  const setCategory = useCallback((id: string, category: string) =>
    setState((s) => {
      const categories = [...s.categories];
      const cat = ensureCategory(categories, category);
      const transactions = s.transactions.map((t) => (t.id === id ? { ...t, category: cat.name, categoryId: cat.id } : t));
      return { ...s, categories, transactions };
    }), []);

  const setBudget = useCallback((category: string, amount: number) =>
    setState((s) => {
      const categories = [...s.categories];
      const cat = ensureCategory(categories, category);
      return { ...s, categories, budgets: upsertBudget(s.budgets, cat.id, currentMonth(), Math.max(0, amount || 0)) };
    }), []);

  const reset = useCallback(() => setState(emptyLedger()), []);

  return { state, loading, error, runSync, setCategory, setBudget, reset };
}

export type Ledger = ReturnType<typeof useLedger>;
