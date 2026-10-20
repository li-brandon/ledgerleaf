import { isDemoSource } from '../lib/sync/mockProvider';
import type { Account, LedgerState } from '../lib/types';
import { readLedger, saveLedger } from './ledger';
import type { Repository } from './repository';

export interface DemoCounts {
  accounts: number;
  transactions: number;
  balanceSnapshots: number;
}

/**
 * Demo accounts to delete: those the demo provider created that no other data uses. Accounts
 * saved before sources were recorded count as demo when only demo transactions reference them.
 */
function demoAccountIds(state: Pick<LedgerState, 'accounts' | 'transactions'>): Set<string> {
  const used = new Map<string, { demo: number; other: number }>();
  for (const t of state.transactions) {
    const u = used.get(t.accountId) ?? { demo: 0, other: 0 };
    u[isDemoSource(t.source) ? 'demo' : 'other']++;
    used.set(t.accountId, u);
  }
  const ids = new Set<string>();
  for (const a of state.accounts) {
    const u = used.get(a.id);
    if (u?.other) continue;
    if (isDemoSource(a.source) || (a.source === undefined && u?.demo)) ids.add(a.id);
  }
  return ids;
}

/** How much demo data the ledger holds. */
export function demoCounts(state: LedgerState): DemoCounts {
  const accounts = demoAccountIds(state);
  return {
    accounts: accounts.size,
    transactions: state.transactions.filter((t) => isDemoSource(t.source)).length,
    balanceSnapshots: state.balanceSnapshots.filter((s) => isDemoSource(s.source) || accounts.has(s.accountId)).length,
  };
}

export const hasDemoData = (state: LedgerState) => {
  const c = demoCounts(state);
  return c.accounts + c.transactions + c.balanceSnapshots > 0;
};

/**
 * The ledger without demo data: demo transactions and balance snapshots, demo accounts, and
 * the demo provider's sync record. Imported data is untouched; a demo account that imported
 * transactions were added to is kept as a plain account (its demo balance dropped, so the
 * balance is derived from what remains). Pure; returns `state` itself if there is no demo data.
 */
export function withoutDemo(state: LedgerState): LedgerState {
  const removed = demoAccountIds(state);
  const transactions = state.transactions.filter((t) => !isDemoSource(t.source));
  const balanceSnapshots = state.balanceSnapshots.filter((s) => !isDemoSource(s.source) && !removed.has(s.accountId));
  const demoSyncs = Object.keys(state.syncs ?? {}).filter(isDemoSource);
  const keptDemo = state.accounts.filter((a) => isDemoSource(a.source) && !removed.has(a.id));
  if (
    !removed.size && !keptDemo.length && !demoSyncs.length
    && transactions.length === state.transactions.length && balanceSnapshots.length === state.balanceSnapshots.length
  ) return state;

  const accounts = state.accounts.flatMap((a): Account[] => {
    if (removed.has(a.id)) return [];
    if (!isDemoSource(a.source)) return [a];
    const { source: _source, balance: _balance, ...rest } = a;
    return [rest];
  });
  const next: LedgerState = { ...state, accounts, transactions, balanceSnapshots };
  if (demoSyncs.length) {
    const syncs = Object.entries(state.syncs ?? {}).filter(([id]) => !isDemoSource(id));
    next.syncs = syncs.length ? Object.fromEntries(syncs) : undefined;
    next.lastSync = syncs.map(([, s]) => s.lastSync).sort().at(-1);
  }
  if (state.importMappings) {
    const mappings = Object.entries(state.importMappings).filter(([id]) => !removed.has(id));
    next.importMappings = mappings.length ? Object.fromEntries(mappings) : undefined;
  }
  return next;
}

/**
 * Remove demo data from the stored ledger in one transaction: either all of it goes or,
 * if the write fails, nothing changes. Resolves to the ledger now stored.
 */
export async function clearDemoData(repo: Repository): Promise<LedgerState | undefined> {
  const prev = await readLedger(repo);
  if (!prev) return undefined;
  const next = withoutDemo(prev);
  if (next !== prev) await saveLedger(repo, next, prev);
  return next;
}
