import { useCallback, useEffect, useRef, useState } from 'react';
import { currentMonth, upsertBudget } from './lib/budget';
import { ensureCategory } from './lib/categories';
import { V1_KEY, V2_KEY, emptyLedger, migrate, normalizeLedger } from './lib/migrate';
import { mergeSync, type SyncProvider } from './lib/sync';
import type { LedgerState } from './lib/types';

export type { LedgerState };

/** Read v2, else migrate the v1 save (left in place as a backup), else start empty. */
function load(): LedgerState {
  try {
    const raw = localStorage.getItem(V2_KEY) ?? localStorage.getItem(V1_KEY);
    return raw ? migrate(JSON.parse(raw)) : emptyLedger();
  } catch {
    return emptyLedger();
  }
}

export function useLedger() {
  const [state, setState] = useState<LedgerState>(load);
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
    localStorage.setItem(V2_KEY, JSON.stringify(state));
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

  return { state, runSync, setCategory, setBudget, reset };
}

export type Ledger = ReturnType<typeof useLedger>;
