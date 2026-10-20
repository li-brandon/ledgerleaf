import { describe, expect, it } from 'vitest';
import { emptyLedger } from '../migrate';
import { applyRules } from '../rules';
import {
  addMerchantRule, editTransaction, merchantRule, removeMerchantRule, reviewCount, setCategory, setReviewed,
} from '../txEdits';
import type { LedgerState, Rule, Transaction } from '../types';

const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  id, date: '2026-10-01', description: id, amount: -10, category: 'Other', categoryId: 'other', accountId: 'a1',
  merchant: id, reviewed: false, ...over,
});

function ledger(transactions: Transaction[], rules: Rule[] = []): LedgerState {
  return { ...emptyLedger('2026-10'), transactions, rules };
}

const byId = (s: LedgerState, id: string) => s.transactions.find((t) => t.id === id)!;

describe('reviewCount', () => {
  it('counts transactions that are not reviewed', () => {
    expect(reviewCount([tx('a'), tx('b', { reviewed: true }), tx('c', { reviewed: undefined })])).toBe(2);
    expect(reviewCount([])).toBe(0);
  });
});

describe('editTransaction', () => {
  it('edits merchant, notes and reviewed on one transaction only', () => {
    const s = ledger([tx('a'), tx('b')]);
    const next = editTransaction(s, 'a', { merchant: ' Blue Bottle ', notes: 'Team coffee', reviewed: true });
    expect(byId(next, 'a')).toMatchObject({ merchant: 'Blue Bottle', notes: 'Team coffee', reviewed: true });
    expect(byId(next, 'b')).toBe(s.transactions[1]);
  });

  it('falls back to the description for a blank merchant and drops blank notes', () => {
    const s = ledger([tx('a', { description: 'SQ *CAFE', merchant: 'Cafe', notes: 'x' })]);
    const next = editTransaction(s, 'a', { merchant: '  ', notes: ' ' });
    expect(byId(next, 'a').merchant).toBe('SQ *CAFE');
    expect(byId(next, 'a')).not.toHaveProperty('notes');
  });

  it('returns the same ledger when nothing changes or the id is unknown', () => {
    const s = ledger([tx('a', { notes: 'n' })]);
    expect(editTransaction(s, 'a', { merchant: 'a', notes: 'n', reviewed: false })).toBe(s);
    expect(editTransaction(s, 'nope', { notes: 'hi' })).toBe(s);
  });
});

describe('manual edits win over rules', () => {
  const rules: Rule[] = [{ id: 'r', categoryId: 'dining', merchantContains: 'cafe', renameMerchant: 'Cafe' }];

  it('marks a renamed merchant as the user\'s, and a blank one as the provider\'s again', () => {
    const s = ledger([tx('SQ *CAFE')], rules);
    const renamed = editTransaction(s, 'SQ *CAFE', { merchant: 'Corner Cafe' });
    expect(byId(renamed, 'SQ *CAFE')).toMatchObject({ merchant: 'Corner Cafe', merchantEdited: true });
    expect(applyRules(rules, byId(renamed, 'SQ *CAFE')).merchant).toBe('Corner Cafe');
    const cleared = editTransaction(renamed, 'SQ *CAFE', { merchant: '' });
    expect(byId(cleared, 'SQ *CAFE')).not.toHaveProperty('merchantEdited');
    expect(applyRules(rules, byId(cleared, 'SQ *CAFE')).merchant).toBe('Cafe');
  });

  it('marks a category set by hand as the user\'s', () => {
    const s = ledger([tx('SQ *CAFE'), tx('b')], rules);
    const next = setCategory(s, ['SQ *CAFE'], 'Travel');
    expect(byId(next, 'SQ *CAFE')).toMatchObject({ categoryId: 'travel', categoryEdited: true });
    expect(byId(next, 'b')).not.toHaveProperty('categoryEdited');
    expect(applyRules(rules, byId(next, 'SQ *CAFE')).categoryId).toBe('travel');
    expect(byId(setCategory(s, ['b'], 'Travel', false), 'b')).not.toHaveProperty('categoryEdited');
  });

  it('does not let a new merchant rule override categories picked by hand', () => {
    const s = setCategory(ledger([tx('t1', { description: 'CAFE' }), tx('t2', { description: 'CAFE' })]), ['t2'], 'Travel');
    const next = addMerchantRule(s, 't1', 'Dining');
    expect(next.transactions.map((t) => [t.categoryId, !!t.categoryEdited])).toEqual([['dining', true], ['travel', true]]);
  });
});

describe('bulk edits', () => {
  it('marks several transactions reviewed, keeping untouched rows by reference', () => {
    const s = ledger([tx('a'), tx('b'), tx('c', { reviewed: true })]);
    const next = setReviewed(s, ['a', 'c'], true);
    expect(next.transactions.map((t) => t.reviewed)).toEqual([true, false, true]);
    expect(next.transactions[1]).toBe(s.transactions[1]);
    expect(next.transactions[2]).toBe(s.transactions[2]);
    expect(setReviewed(next, ['a', 'c'], true)).toBe(next);
    expect(reviewCount(setReviewed(next, ['a', 'b', 'c'], false).transactions)).toBe(3);
  });

  it('sets the category of several transactions by name, case-insensitively', () => {
    const s = ledger([tx('a'), tx('b'), tx('c')]);
    const next = setCategory(s, ['a', 'c'], 'dining');
    expect(next.transactions.map((t) => t.categoryId)).toEqual(['dining', 'other', 'dining']);
    expect(byId(next, 'a').category).toBe('Dining');
    expect(next.categories).toBe(s.categories);
    expect(setCategory(next, ['a'], 'Dining')).toBe(next);
  });

  it('creates a custom category for an unknown name', () => {
    const s = ledger([tx('a')]);
    const next = setCategory(s, ['a'], 'Coffee Shops');
    expect(byId(next, 'a')).toMatchObject({ category: 'Coffee Shops', categoryId: 'coffee-shops' });
    expect(next.categories).toHaveLength(s.categories.length + 1);
    expect(s.categories.some((c) => c.id === 'coffee-shops')).toBe(false);
  });
});

describe('addMerchantRule', () => {
  it('creates a merchant rule and applies it to unreviewed transactions from the merchant', () => {
    const s = ledger([
      tx('t1', { description: 'BLUE BOTTLE', merchant: 'Blue Bottle Coffee' }),
      tx('t2', { description: 'Blue Bottle' }),
      tx('t3', { description: 'BLUE BOTTLE', reviewed: true, category: 'Travel', categoryId: 'travel' }),
      tx('t4', { description: 'Bakery' }),
    ]);
    const next = addMerchantRule(s, 't1', 'Dining');
    expect(next.rules).toEqual([{ id: expect.stringMatching(/^rule-/), merchant: 'BLUE BOTTLE', categoryId: 'dining' }]);
    expect(next.transactions.map((t) => t.categoryId)).toEqual(['dining', 'dining', 'travel', 'other']);
    expect(merchantRule(next.rules, byId(next, 't2'))).toBe(next.rules[0]);
  });

  it('applies to the transaction itself even when it is reviewed', () => {
    const s = ledger([tx('t1', { reviewed: true })]);
    expect(byId(addMerchantRule(s, 't1', 'Health'), 't1').categoryId).toBe('health');
  });

  it('replaces the merchant rule instead of adding another, and puts it first', () => {
    const older: Rule = { id: 'old', categoryId: 'shopping', descriptionContains: 'cafe' };
    const s = addMerchantRule(ledger([tx('Cafe')], [older]), 'Cafe', 'Dining');
    const again = addMerchantRule(s, 'Cafe', 'Groceries');
    expect(again.rules.map((r) => [r.id, r.categoryId])).toEqual([[s.rules[0].id, 'groceries'], ['old', 'shopping']]);
    expect(byId(again, 'Cafe').categoryId).toBe('groceries');
  });

  it('removes only the merchant rule, keeping categories already set', () => {
    const other: Rule = { id: 'other', categoryId: 'dining', merchant: 'Cafe', amountMin: -5 };
    const s = addMerchantRule(ledger([tx('Cafe')], [other]), 'Cafe', 'Dining');
    const next = removeMerchantRule(s, 'Cafe');
    expect(next.rules).toEqual([other]);
    expect(byId(next, 'Cafe').categoryId).toBe('dining');
    expect(removeMerchantRule(next, 'Cafe')).toBe(next);
  });
});
