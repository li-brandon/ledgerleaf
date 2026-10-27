import { accountBalance } from './insights';
import type { BalanceSnapshot, ImportBatch, ImportSnapshot, LedgerState, Transaction } from './types';

/** What the import screen knows about an import before it runs. */
export type ImportDraft = Pick<ImportBatch, 'id' | 'file' | 'accountId' | 'rows' | 'at'>;

/** A batch id no other import uses, even one of the same file at the same moment. */
export const newBatchId = () => `imp-${crypto.randomUUID()}`;

const snapshotKey = (s: Pick<BalanceSnapshot, 'accountId' | 'date'>) => `${s.accountId}|${s.date}`;

/**
 * Record a CSV import that turned `prev` into `next`. Every row of the file (`fileIds`, the ids
 * of the transactions the provider read) that the import added, or that matched one already held
 * that some import claims, gets the batch id appended to its `importBatchIds`; so does any
 * transaction the import added under another id. A matched row no import claims (imported before
 * batches were recorded, or restored from an older backup) is never claimed, so no undo deletes
 * it. A deleted transaction in `fileIds` (one the file had, skipped as deleted) gets the batch id
 * too, so Undo of the delete gives the row the claim (see `restoreTransaction`). The batch notes what else the import created or replaced (the
 * account, categories, balance snapshots) so {@link undoImport} can take it back. Pure.
 */
export function recordImport(next: LedgerState, prev: LedgerState, draft: ImportDraft, fileIds: Iterable<string>): LedgerState {
  const had = new Set(prev.transactions.map((t) => t.id));
  const inFile = new Set(fileIds);
  let added = 0;
  const transactions = next.transactions.map((t) => {
    if (!had.has(t.id)) added++;
    else if (!inFile.has(t.id) || !t.importBatchIds?.length) return t;
    return t.importBatchIds?.includes(draft.id) ? t : { ...t, importBatchIds: [...(t.importBatchIds ?? []), draft.id] };
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
  const deletedTransactions = next.deletedTransactions?.map((d) =>
    (inFile.has(d.id) ? { ...d, importBatchIds: [...(d.importBatchIds ?? []), draft.id] } : d));
  return { ...next, transactions, ...(deletedTransactions && { deletedTransactions }), importBatches: [batch, ...(next.importBatches ?? [])] };
}

/** The transaction would be deleted by undoing `batchId`: no other batch claims it. */
const onlyIn = (t: Transaction, batchId: string) => t.importBatchIds?.length === 1 && t.importBatchIds[0] === batchId;

/** How many transactions undoing `batchId` would remove. */
export const batchTransactionCount = (state: Pick<LedgerState, 'transactions'>, batchId: string) =>
  state.transactions.filter((t) => onlyIn(t, batchId)).length;

/**
 * The ledger without the import `batchId`. Pure; returns `state` itself if there is nothing to undo.
 *
 * - Transactions: the batch id is taken off every row; rows no other batch claims are deleted.
 *   Rows no batch ever claimed are never deleted.
 * - Balance snapshots, for each key (account and day) the batch wrote, and each key a newer
 *   remaining batch wrote for the same account: if the snapshot still has the balance its newest
 *   writer recorded (no other sync rewrote it since), it becomes
 *   - if a remaining batch wrote it, the account's balance when the newest such batch R ran:
 *     the remaining transactions of the account that no batch claims, or that some batch other
 *     than one newer than R claims (they existed when R wrote it); R's record takes that value;
 *   - otherwise the value from before any import wrote it (the earliest writer's `before`), or
 *     nothing. When the undone batch was not the earliest writer of a key, its `before` is handed
 *     on to the next writer, so the earliest writer always holds the pre-import value.
 *   "Newer" is by position in `importBatches`, which is newest first.
 * - An account the batch created is handed on to the oldest remaining batch into that account;
 *   with none, it is removed if it has no transactions left, with its snapshots, saved mapping
 *   and the rules scoped to it. Categories the batch created are removed if no transaction, rule
 *   or budget uses them; the rest are handed on like the account, so whichever batch is undone
 *   last checks them again.
 *
 * Every other transaction, batch, rule, budget and recurring choice is left as it is; sync
 * times and an existing account's saved column mapping stay too.
 */
export function undoImport(state: LedgerState, batchId: string): LedgerState {
  const all = state.importBatches ?? [];
  const index = all.findIndex((b) => b.id === batchId);
  const batch = all[index] as ImportBatch | undefined;
  if (!batch && !state.transactions.some((t) => t.importBatchIds?.includes(batchId))) return state;

  const transactions = state.transactions.flatMap((t): Transaction[] => {
    if (!t.importBatchIds?.includes(batchId)) return [t];
    if (onlyIn(t, batchId)) return [];
    return [{ ...t, importBatchIds: t.importBatchIds.filter((id) => id !== batchId) }];
  });
  // Remaining batches, newest first, each with its own copy of the snapshots so they can be updated.
  const batches = all.filter((b) => b.id !== batchId)
    .map((b) => (b.snapshots ? { ...b, snapshots: b.snapshots.map((w) => ({ ...w })) } : { ...b }));

  // Snapshots: hand the undone batch's `before` on, then recompute every affected key.
  const writes = (b: ImportBatch, key: string) => b.snapshots?.find((w) => snapshotKey(w) === key);
  const accountIds = new Set(batch?.snapshots?.map((w) => w.accountId));
  const keys = new Set(batch?.snapshots?.map(snapshotKey));
  for (const b of batches.slice(0, index)) {
    for (const w of b.snapshots ?? []) if (accountIds.has(w.accountId)) keys.add(snapshotKey(w));
  }
  let balanceSnapshots = state.balanceSnapshots;
  for (const key of keys) {
    const mine = batch && writes(batch, key);
    const later = batches.slice(0, index).map((b) => writes(b, key)).filter((w) => w !== undefined);
    const newestWrite = later[0] ?? mine!;
    if (mine && later.length) {
      const next = later.at(-1)!;
      if (mine.before) next.before = mine.before;
      else delete next.before;
    }
    const i = balanceSnapshots.findIndex((s) => snapshotKey(s) === key);
    if (i < 0 || balanceSnapshots[i].balance !== newestWrite.balance) continue;
    const writerAt = batches.findIndex((b) => writes(b, key));
    const writer = batches[writerAt];
    let value: BalanceSnapshot | undefined;
    if (writer) {
      const newer = new Set(batches.slice(0, writerAt).map((b) => b.id));
      const account = state.accounts.find((a) => a.id === newestWrite.accountId);
      if (!account) continue;
      const existed = transactions.filter((t) => !t.importBatchIds?.length || t.importBatchIds.some((id) => !newer.has(id)));
      const w = writes(writer, key)!;
      w.balance = accountBalance(account, existed);
      value = { ...balanceSnapshots[i], balance: w.balance };
    } else {
      value = mine?.before;
    }
    balanceSnapshots = value
      ? balanceSnapshots.map((s, j) => (j === i ? value : s))
      : balanceSnapshots.filter((_, j) => j !== i);
  }

  const next: LedgerState = { ...state, transactions, balanceSnapshots };
  const accountId = batch?.accountId;
  const heir = batches.filter((b) => b.accountId === accountId).at(-1);
  if (heir && batch?.newAccount) heir.newAccount = true;
  else if (batch?.newAccount && !transactions.some((t) => t.accountId === accountId)) {
    next.accounts = state.accounts.filter((a) => a.id !== accountId);
    next.balanceSnapshots = balanceSnapshots.filter((s) => s.accountId !== accountId);
    next.rules = state.rules.filter((r) => r.accountId !== accountId);
    if (state.importMappings && accountId! in state.importMappings) {
      const { [accountId!]: _gone, ...rest } = state.importMappings;
      next.importMappings = Object.keys(rest).length ? rest : undefined;
    }
  }
  if (batch?.categories?.length) {
    const used = new Set([...transactions, ...next.rules, ...state.budgets].map((x) => x.categoryId));
    const gone = new Set(batch.categories.filter((id) => !used.has(id)));
    if (gone.size) next.categories = state.categories.filter((c) => !gone.has(c.id));
    const kept = batch.categories.filter((id) => !gone.has(id));
    if (heir && kept.length) heir.categories = [...new Set([...heir.categories ?? [], ...kept])];
  }
  next.importBatches = batches.length ? batches : undefined;
  return next;
}
