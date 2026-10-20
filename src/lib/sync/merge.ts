import type { Account } from '../types';
import type { SyncResult } from './types';

export interface MergeOutcome extends SyncResult {
  added: number;
}

/**
 * Merge a sync result into existing data. Transactions are deduped by id and
 * existing ones win, so user edits (e.g. re-categorisation) survive re-syncs.
 */
export function mergeSync(existing: SyncResult, incoming: SyncResult): MergeOutcome {
  const accounts = new Map<string, Account>(existing.accounts.map((a) => [a.id, a]));
  for (const a of incoming.accounts) {
    const prev = accounts.get(a.id);
    accounts.set(a.id, { ...prev, ...a, balance: a.balance ?? prev?.balance });
  }
  const seen = new Set(existing.transactions.map((t) => t.id));
  const fresh = incoming.transactions.filter((t) => !seen.has(t.id) && seen.add(t.id));
  const transactions = [...existing.transactions, ...fresh].sort((a, b) =>
    b.date.localeCompare(a.date),
  );
  return { accounts: [...accounts.values()], transactions, added: fresh.length };
}
