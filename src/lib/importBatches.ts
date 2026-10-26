import type { BalanceSnapshot, ImportBatch, ImportSnapshot, LedgerState } from './types';

/** What the import screen knows about an import before it runs. */
export type ImportDraft = Pick<ImportBatch, 'id' | 'file' | 'accountId' | 'rows' | 'at'>;

/** A batch id no other import uses, even one of the same file at the same moment. */
export const newBatchId = () => `imp-${crypto.randomUUID()}`;

const snapshotKey = (s: Pick<BalanceSnapshot, 'accountId' | 'date'>) => `${s.accountId}|${s.date}`;

/**
 * Record a CSV import that turned `prev` into `next`: the transactions it added (and only
 * those; rows that matched an existing transaction keep whatever batch they had) are tagged
 * with the batch id, and the batch notes what else the import created or replaced (the
 * account, categories, balance snapshots) so {@link undoImport} can take it back. Pure.
 */
export function recordImport(next: LedgerState, prev: LedgerState, draft: ImportDraft): LedgerState {
  const had = new Set(prev.transactions.map((t) => t.id));
  let added = 0;
  const transactions = next.transactions.map((t) => {
    if (had.has(t.id)) return t;
    added++;
    return { ...t, importBatchId: draft.id };
  });
  const batch: ImportBatch = { ...draft, added };
  if (!prev.accounts.some((a) => a.id === draft.accountId) && next.accounts.some((a) => a.id === draft.accountId)) {
    batch.newAccount = true;
  }
  const hadCategory = new Set(prev.categories.map((c) => c.id));
  const categories = next.categories.filter((c) => !hadCategory.has(c.id)).map((c) => c.id);
  if (categories.length) batch.categories = categories;
  const before = new Map(prev.balanceSnapshots.map((s) => [snapshotKey(s), s]));
  const snapshots = next.balanceSnapshots.flatMap((s): ImportSnapshot[] => {
    const b = before.get(snapshotKey(s));
    if (b && b.balance === s.balance && b.source === s.source) return [];
    return [{ accountId: s.accountId, date: s.date, balance: s.balance, ...(b && { before: b }) }];
  });
  if (snapshots.length) batch.snapshots = snapshots;
  return { ...next, transactions, importBatches: [batch, ...(next.importBatches ?? [])] };
}

/** How many transactions undoing `batchId` would remove. */
export const batchTransactionCount = (state: Pick<LedgerState, 'transactions'>, batchId: string) =>
  state.transactions.filter((t) => t.importBatchId === batchId).length;

/**
 * The ledger without the import `batchId`: every transaction tagged with it and the batch
 * record are removed, and what the import created is taken back: the balance snapshots it
 * wrote (unless a later sync has rewritten them) go back to what they were, and the account
 * and categories it created are removed once nothing else uses them. Every other transaction,
 * batch, rule, budget and recurring choice is left as it is; sync times and the account's saved
 * column mapping stay too. Pure; returns `state` itself if there is nothing to undo.
 */
export function undoImport(state: LedgerState, batchId: string): LedgerState {
  const batch = state.importBatches?.find((b) => b.id === batchId);
  const transactions = state.transactions.filter((t) => t.importBatchId !== batchId);
  if (!batch && transactions.length === state.transactions.length) return state;

  let balanceSnapshots = state.balanceSnapshots;
  for (const w of batch?.snapshots ?? []) {
    const i = balanceSnapshots.findIndex((s) => snapshotKey(s) === snapshotKey(w));
    if (i < 0 || balanceSnapshots[i].balance !== w.balance) continue;
    balanceSnapshots = w.before
      ? balanceSnapshots.map((s, j) => (j === i ? w.before! : s))
      : balanceSnapshots.filter((_, j) => j !== i);
  }

  const next: LedgerState = { ...state, transactions, balanceSnapshots };
  const accountId = batch?.accountId;
  if (batch?.newAccount && !transactions.some((t) => t.accountId === accountId)) {
    next.accounts = state.accounts.filter((a) => a.id !== accountId);
    next.balanceSnapshots = balanceSnapshots.filter((s) => s.accountId !== accountId);
    if (state.importMappings && accountId! in state.importMappings) {
      const { [accountId!]: _gone, ...rest } = state.importMappings;
      next.importMappings = Object.keys(rest).length ? rest : undefined;
    }
  }
  if (batch?.categories?.length) {
    const used = new Set([...transactions, ...state.rules, ...state.budgets].map((x) => x.categoryId));
    const gone = new Set(batch.categories.filter((id) => !used.has(id)));
    if (gone.size) next.categories = state.categories.filter((c) => !gone.has(c.id));
  }
  const batches = (state.importBatches ?? []).filter((b) => b.id !== batchId);
  next.importBatches = batches.length ? batches : undefined;
  return next;
}
