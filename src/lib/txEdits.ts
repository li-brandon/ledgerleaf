/**
 * User edits to transactions (category, merchant, notes, reviewed, deleting one) and the
 * "always categorize like this" rules they can create. Pure, so it can be unit tested.
 */
import { ensureCategory } from './categories';
import { isMerchantOnly, ruleMatches } from './rules';
import { hashId } from './sync/hash';
import { dedupeKey } from './sync/merge';
import type { DeletedTransaction, LedgerState, Rule, Transaction } from './types';

/** Fields the transaction detail can edit. */
export interface TxEdit {
  merchant?: string;
  notes?: string;
  reviewed?: boolean;
}

/** How many transactions still need review. */
export const reviewCount = (transactions: readonly Transaction[]) =>
  transactions.reduce((n, t) => (t.reviewed ? n : n + 1), 0);

/** Apply `fn` to the transactions in `ids`; unchanged rows (and an unchanged ledger) keep their reference. */
function mapTransactions(
  state: LedgerState, ids: Iterable<string>, fn: (t: Transaction) => Transaction,
): LedgerState {
  const want = new Set(ids);
  let changed = false;
  const transactions = state.transactions.map((t) => {
    if (!want.has(t.id)) return t;
    const next = fn(t);
    if (next !== t) changed = true;
    return next;
  });
  return changed ? { ...state, transactions } : state;
}

/**
 * Edit merchant, notes or reviewed on one transaction. A renamed merchant is marked as the
 * user's, so rules leave it alone; a blank merchant falls back to the description and lets
 * rules rename it again. Blank notes are removed. Returns `state` itself when nothing changes.
 */
export function editTransaction(state: LedgerState, id: string, edit: TxEdit): LedgerState {
  return mapTransactions(state, [id], (t) => {
    const next: Transaction = { ...t };
    if (edit.merchant !== undefined && (edit.merchant.trim() || t.description) !== t.merchant) {
      // A blank merchant hands the name back to the provider description (and to rules).
      next.merchant = edit.merchant.trim() || t.description;
      if (edit.merchant.trim()) next.merchantEdited = true;
      else delete next.merchantEdited;
    }
    if (edit.notes !== undefined) {
      if (edit.notes.trim()) next.notes = edit.notes;
      else delete next.notes;
    }
    if (edit.reviewed !== undefined) next.reviewed = edit.reviewed;
    const same = next.merchant === t.merchant && next.notes === t.notes && next.reviewed === t.reviewed
      && next.merchantEdited === t.merchantEdited;
    return same ? t : next;
  });
}

const tombstone = ({ id, accountId, date, description, amount, source, externalId }: Transaction): DeletedTransaction => ({
  id, accountId, date, description, amount, ...(source !== undefined && { source }), ...(externalId !== undefined && { externalId }),
});

/**
 * Delete one transaction, remembering it (see {@link DeletedTransaction}) so a re-sync or a
 * re-import of the same file does not add it back. Import batches keep their record: undoing one
 * finds the row already gone. Returns `state` itself for an unknown id.
 */
export function deleteTransaction(state: LedgerState, id: string): LedgerState {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return state;
  return {
    ...state,
    transactions: state.transactions.filter((x) => x !== t),
    deletedTransactions: [...state.deletedTransactions ?? [], tombstone(t)],
  };
}

/**
 * Undo {@link deleteTransaction} of `t`: forget its tombstone and put it back as it was, in date
 * order. Claims of import batches undone since the delete are dropped; when every import that
 * claimed it has been undone (which would have removed it), or its account is gone, it stays
 * deleted. Against the current ledger, so it is a no-op if the row is already back.
 */
export function restoreTransaction(state: LedgerState, t: Transaction): LedgerState {
  const key = dedupeKey(t);
  const deleted = state.deletedTransactions ?? [];
  const kept = deleted.filter((d) => dedupeKey(d) !== key);
  const next = kept.length === deleted.length ? state : { ...state, deletedTransactions: kept.length ? kept : undefined };

  const batches = new Set(state.importBatches?.map((b) => b.id));
  const claims = t.importBatchIds?.filter((id) => batches.has(id)) ?? [];
  const held = state.transactions.some((x) => x.id === t.id || dedupeKey(x) === key);
  const undone = !!t.importBatchIds?.length && !claims.length;
  if (held || undone || !state.accounts.some((a) => a.id === t.accountId)) return next;

  const row = claims.length === (t.importBatchIds?.length ?? 0) ? t : { ...t, importBatchIds: claims };
  const transactions = [...next.transactions];
  const at = transactions.findIndex((x) => x.date < t.date);
  transactions.splice(at < 0 ? transactions.length : at, 0, row);
  return { ...next, transactions };
}

/** Mark every transaction in `ids` reviewed (or not). */
export const setReviewed = (state: LedgerState, ids: Iterable<string>, reviewed: boolean) =>
  mapTransactions(state, ids, (t) => (!!t.reviewed === reviewed ? t : { ...t, reviewed }));

/**
 * Set the category of every transaction in `ids` by name, creating a custom category for
 * an unknown name. `byUser` (the default) marks the category as the user's choice, which
 * rules never override; rules themselves pass false.
 */
export function setCategory(state: LedgerState, ids: Iterable<string>, name: string, byUser = true): LedgerState {
  const categories = [...state.categories];
  const cat = ensureCategory(categories, name);
  const next = mapTransactions(state, ids, (t) => {
    if (t.categoryId === cat.id && t.category === cat.name) return t;
    return byUser ? { ...t, category: cat.name, categoryId: cat.id, categoryEdited: true } : { ...t, category: cat.name, categoryId: cat.id };
  });
  if (categories.length === state.categories.length) return next;
  return { ...next, categories };
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

/** The merchant key an "always categorize like this" rule uses for `t`: the provider's description. */
export const ruleMerchant = (t: Transaction) => t.description.trim();

/** A rule that only matches on this merchant (no other conditions). */
const isMerchantRule = (r: Rule, merchant: string) => isMerchantOnly(r) && norm(r.merchant) === norm(merchant);

/** The "always categorize like this" rule for `t`'s merchant, if there is one. */
export const merchantRule = (rules: readonly Rule[], t: Transaction) =>
  rules.find((r) => isMerchantRule(r, ruleMerchant(t)));

/**
 * Create (or update) the rule "always categorize this merchant as `name`", taking precedence
 * over older rules, and apply it to the other transactions from the merchant that have not
 * been reviewed yet. Reviewed transactions, and categories the user picked by hand, are
 * left as they are.
 */
export function addMerchantRule(state: LedgerState, id: string, name: string): LedgerState {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return state;
  const merchant = ruleMerchant(t);
  const categories = [...state.categories];
  const cat = ensureCategory(categories, name);
  const existing = merchantRule(state.rules, t);
  const rule: Rule = { id: existing?.id ?? `rule-${hashId(norm(merchant))}`, merchant, categoryId: cat.id };
  const rules = [rule, ...state.rules.filter((r) => r !== existing)];
  const next = { ...state, categories, rules };
  const others = state.transactions
    .filter((x) => x.id !== id && !x.reviewed && !x.categoryEdited && ruleMatches(rule, x)).map((x) => x.id);
  return setCategory(setCategory(next, [id], cat.name), others, cat.name, false);
}

/** Remove the "always categorize like this" rule for `id`'s merchant. Categories already set are kept. */
export function removeMerchantRule(state: LedgerState, id: string): LedgerState {
  const t = state.transactions.find((x) => x.id === id);
  const existing = t && merchantRule(state.rules, t);
  return existing ? { ...state, rules: state.rules.filter((r) => r !== existing) } : state;
}
