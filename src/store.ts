import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeSync, type SyncProvider } from './lib/sync';
import type { Account, Budgets, Transaction } from './lib/types';

export interface LedgerState {
  accounts: Account[];
  transactions: Transaction[];
  budgets: Budgets;
  lastSync?: string;
}

const KEY = 'ledgerleaf:v1';

const DEFAULT_BUDGETS: Budgets = {
  Rent: 1650, Groceries: 500, Dining: 300, Shopping: 250, Transport: 150,
  Utilities: 150, Entertainment: 80, Health: 60,
};

const empty = (): LedgerState => ({ accounts: [], transactions: [], budgets: { ...DEFAULT_BUDGETS } });

function load(): LedgerState {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty(), ...JSON.parse(raw) } : empty();
  } catch {
    return empty();
  }
}

export function useLedger() {
  const [state, setState] = useState<LedgerState>(load);
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
    localStorage.setItem(KEY, JSON.stringify(state));
  }, [state]);

  const runSync = useCallback(async (provider: SyncProvider) => {
    const incoming = await provider.sync();
    const { added, accounts, transactions } = mergeSync(latest.current, incoming);
    const next = { ...latest.current, accounts, transactions, lastSync: new Date().toISOString() };
    latest.current = next;
    setState(next);
    return { added, received: incoming.transactions.length };
  }, []);

  const setCategory = useCallback((id: string, category: string) =>
    setState((s) => ({ ...s, transactions: s.transactions.map((t) => (t.id === id ? { ...t, category } : t)) })), []);

  const setBudget = useCallback((category: string, amount: number) =>
    setState((s) => ({ ...s, budgets: { ...s.budgets, [category]: Math.max(0, amount || 0) } })), []);

  const reset = useCallback(() => setState(empty()), []);

  return { state, runSync, setCategory, setBudget, reset };
}

export type Ledger = ReturnType<typeof useLedger>;
