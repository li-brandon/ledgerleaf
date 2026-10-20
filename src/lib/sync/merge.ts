import { categorize } from '../txEdits';
import type { Account, Rule, Transaction } from '../types';
import type { SyncResult } from './types';

export interface MergeOutcome {
  accounts: Account[];
  transactions: Transaction[];
  /** Transactions that were not in the ledger before. */
  added: number;
  /** Existing transactions whose provider-owned fields changed. */
  updated: number;
}

/**
 * Fields a re-sync may refresh on a transaction it already holds. Everything else
 * (category, categoryId, notes, reviewed, merchant, …) belongs to the user and is never
 * overwritten.
 */
const PROVIDER_TX_FIELDS = ['date', 'description', 'amount', 'accountId', 'source', 'externalId'] as const;
/** Account fields a re-sync may refresh; `hidden` stays as the user left it, and so does a name they chose. */
const PROVIDER_ACCOUNT_FIELDS = ['name', 'type', 'institution', 'currency', 'balance'] as const;
const accountFields = (prev: Account) =>
  prev.renamed ? PROVIDER_ACCOUNT_FIELDS.filter((f) => f !== 'name') : PROVIDER_ACCOUNT_FIELDS;

/**
 * Identity of a transaction within its provider: source + externalId, falling back to
 * the transaction id (which the built-in providers derive from a content hash).
 */
export const dedupeKey = (t: Transaction) => JSON.stringify([t.source ?? '', t.externalId ?? t.id]);

/** Copy provider-reported fields from `incoming` onto `prev`; returns `prev` itself if nothing changed. */
function refresh<T extends object>(prev: T, incoming: T, fields: readonly (keyof T)[]): T {
  const changed = fields.filter((f) => incoming[f] !== undefined && incoming[f] !== prev[f]);
  if (!changed.length) return prev;
  const next = { ...prev };
  for (const f of changed) next[f] = incoming[f];
  return next;
}

function freeId(id: string, taken: Map<string, unknown>) {
  let n = 1;
  while (taken.has(`${id}~${n}`)) n++;
  return `${id}~${n}`;
}

/**
 * Merge a sync result into existing data. Idempotent: merging the same result again adds
 * nothing and returns unchanged records by reference. Incoming transactions match an
 * existing one by {@link dedupeKey}, or by id when the two come from the same source and
 * do not carry different externalIds. Matches only refresh provider-owned fields, so user
 * edits survive re-syncs. `incoming.balances` update account balances. New transactions
 * always arrive unreviewed, categorized by the first matching rule in `existing.rules`.
 */
export function mergeSync(
  existing: Pick<SyncResult, 'accounts' | 'transactions'> & { rules?: readonly Rule[] },
  incoming: SyncResult,
): MergeOutcome {
  const rules = existing.rules ?? [];
  const accounts = new Map<string, Account>(existing.accounts.map((a) => [a.id, a]));
  for (const a of incoming.accounts) {
    const prev = accounts.get(a.id);
    accounts.set(a.id, prev ? refresh(prev, a, accountFields(prev)) : { ...a });
  }
  for (const b of incoming.balances ?? []) {
    const prev = accounts.get(b.accountId);
    if (prev) accounts.set(b.accountId, refresh(prev, { ...prev, balance: b.balance }, ['balance']));
  }

  const transactions = [...existing.transactions];
  const byKey = new Map<string, number>();
  const byId = new Map<string, number>();
  const index = (t: Transaction, i: number) => {
    if (!byKey.has(dedupeKey(t))) byKey.set(dedupeKey(t), i);
    byId.set(t.id, i);
  };
  transactions.forEach(index);

  let added = 0;
  let updated = 0;
  for (const t of incoming.transactions) {
    let i = byKey.get(dedupeKey(t));
    if (i === undefined) {
      const j = byId.get(t.id);
      const prev = j === undefined ? undefined : transactions[j];
      const sameSource = prev && (prev.source ?? t.source) === t.source;
      if (sameSource && (prev.externalId === undefined || t.externalId === undefined)) i = j;
    }
    if (i !== undefined) {
      const next = refresh(transactions[i], t, PROVIDER_TX_FIELDS);
      if (next !== transactions[i]) {
        transactions[i] = next;
        updated++;
      }
      continue;
    }
    // A different transaction already has this id (e.g. another source): keep both, and
    // remember the provider's id as externalId so the next sync still finds this one.
    const fresh = categorize(rules, { ...t, reviewed: false });
    const row = byId.has(t.id) ? { ...fresh, id: freeId(t.id, byId), externalId: t.externalId ?? t.id } : { ...fresh };
    index(row, transactions.push(row) - 1);
    added++;
  }

  transactions.sort((a, b) => b.date.localeCompare(a.date));
  return { accounts: [...accounts.values()], transactions, added, updated };
}
