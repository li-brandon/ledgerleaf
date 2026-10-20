import { useCallback, useEffect, useRef, useState } from 'react';
import { createPersister, loadLedger, openRepository, type Persister, type Repository } from './db';
import { currentMonth, upsertBudget } from './lib/budget';
import { ensureCategory } from './lib/categories';
import { emptyLedger, normalizeLedger } from './lib/migrate';
import { mergeSync, type SyncProvider } from './lib/sync';
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

  const runSync = useCallback(async (provider: SyncProvider) => {
    const incoming = await provider.sync();
    const tagged = incoming.transactions.map((t) => ({ ...t, source: t.source ?? provider.id }));
    const { added, accounts, transactions } = mergeSync(latest.current, { ...incoming, transactions: tagged });
    const next = normalizeLedger({ ...latest.current, accounts, transactions, lastSync: new Date().toISOString() });
    latest.current = next;
    setState(next);
    return { added, received: incoming.transactions.length };
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
