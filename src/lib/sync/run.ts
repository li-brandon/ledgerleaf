import { normalizeLedger } from '../migrate';
import type { BalanceSnapshot, LedgerState } from '../types';
import { mergeSync } from './merge';
import type { SyncProvider, SyncResult } from './types';

/** A sync that failed; the ledger is left exactly as it was. */
export class SyncError extends Error {
  constructor(readonly providerId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SyncError';
  }
}

/** Local calendar date as YYYY-MM-DD. */
export const localIsoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** First problem with a provider's data, or undefined if it is safe to merge. */
export function findInvalid(r: SyncResult, knownAccountIds: Iterable<string> = []): string | undefined {
  if (!Array.isArray(r.accounts) || !Array.isArray(r.transactions) || (r.balances && !Array.isArray(r.balances))) {
    return 'returned malformed data';
  }
  const accountIds = new Set(knownAccountIds);
  for (const [i, a] of r.accounts.entries()) {
    if (!isText(a?.id) || !isText(a.name)) return `account #${i + 1} has no id or name`;
    if (a.balance !== undefined && !isAmount(a.balance)) return `account "${a.name}" has an invalid balance`;
    accountIds.add(a.id);
  }
  for (const [i, t] of r.transactions.entries()) {
    const what = `transaction #${i + 1}`;
    if (!isText(t?.id)) return `${what} has no id`;
    if (typeof t.date !== 'string' || !ISO_DATE.test(t.date)) return `${what} has an invalid date`;
    if (!isAmount(t.amount)) return `${what} has an invalid amount`;
    if (typeof t.description !== 'string') return `${what} has no description`;
    if (!accountIds.has(t.accountId)) return `${what} belongs to an unknown account`;
  }
  for (const [i, b] of (r.balances ?? []).entries()) {
    if (!accountIds.has(b?.accountId)) return `balance #${i + 1} belongs to an unknown account`;
    if (!isAmount(b.balance)) return `balance #${i + 1} is not a number`;
    if (b.date !== undefined && !ISO_DATE.test(b.date)) return `balance #${i + 1} has an invalid date`;
  }
  return undefined;
}

/** Newest transaction date already held from `providerId`, used as the incremental `since`. */
export function syncSince(state: Pick<LedgerState, 'transactions'>, providerId: string): string | undefined {
  let since: string | undefined;
  for (const t of state.transactions) if (t.source === providerId && (!since || t.date > since)) since = t.date;
  return since;
}

/**
 * Read everything from `provider` and check it. Every account and transaction is stamped
 * with the provider id as its source. Throws a {@link SyncError} if any call fails or the data is
 * malformed, so callers either get a complete result or nothing.
 */
export async function fetchSync(
  provider: SyncProvider, state: Pick<LedgerState, 'accounts' | 'transactions'>,
): Promise<SyncResult> {
  let result: SyncResult;
  try {
    const [accounts, transactions, balances] = await Promise.all([
      provider.listAccounts(),
      provider.fetchTransactions(syncSince(state, provider.id)),
      provider.fetchBalances?.(),
    ]);
    result = { accounts, transactions, balances };
  } catch (e) {
    throw new SyncError(provider.id, `${provider.name} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  const problem = findInvalid(result, state.accounts.map((a) => a.id));
  if (problem) throw new SyncError(provider.id, `${provider.name} ${problem}; nothing was imported.`);
  const source = provider.id;
  return {
    ...result,
    accounts: result.accounts.map((a) => ({ ...a, source })),
    transactions: result.transactions.map((t) => ({ ...t, source })),
  };
}

export interface SyncOutcome {
  state: LedgerState;
  added: number;
  updated: number;
  received: number;
}

/**
 * Upsert one snapshot per account and day, tagged with the provider id; unchanged
 * snapshots keep their reference.
 */
function withSnapshots(prev: BalanceSnapshot[], incoming: SyncResult, today: string, source: string): BalanceSnapshot[] {
  if (!incoming.balances?.length) return prev;
  const out = [...prev];
  const at = new Map(out.map((s, i) => [`${s.accountId}|${s.date}`, i]));
  for (const { accountId, balance, date = today } of incoming.balances) {
    const i = at.get(`${accountId}|${date}`);
    if (i === undefined) at.set(`${accountId}|${date}`, out.push({ accountId, date, balance, source }) - 1);
    else if (out[i].balance !== balance || out[i].source !== source) out[i] = { accountId, date, balance, source };
  }
  return out;
}

/** Merge a fetched result into the ledger and record the sync time for `providerId`. Pure. */
export function applySync(state: LedgerState, providerId: string, incoming: SyncResult, now = new Date()): SyncOutcome {
  const { accounts, transactions, added, updated } = mergeSync(state, incoming);
  const lastSync = now.toISOString();
  const next = normalizeLedger({
    ...state,
    accounts,
    transactions,
    balanceSnapshots: withSnapshots(state.balanceSnapshots, incoming, localIsoDate(now), providerId),
    lastSync,
    syncs: { ...state.syncs, [providerId]: { lastSync } },
  });
  return { state: next, added, updated, received: incoming.transactions.length };
}
