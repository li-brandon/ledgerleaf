import { describe, expect, it } from 'vitest';
import { emptyLedger } from '../migrate';
import {
  applyRules, applyRulesToLedger, findRule, hasConditions, isMerchantOnly, isValidRegex, moveRule, newRuleId,
  normalizeRule, previewRules, removeRule, ruleMatches, upsertRule, validateRule,
} from '../rules';
import type { LedgerState, Rule, Transaction } from '../types';

const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  id, date: '2026-10-01', description: id, amount: -10, category: 'Other', categoryId: 'other', accountId: 'a1',
  merchant: id, reviewed: false, ...over,
});

const rule = (id: string, over: Partial<Rule>): Rule => ({ id, categoryId: 'dining', ...over });

function ledger(transactions: Transaction[], rules: Rule[] = []): LedgerState {
  return { ...emptyLedger('2026-10'), transactions, rules };
}

describe('ruleMatches', () => {
  const t = tx('a', { description: 'SQ *BLUE BOTTLE 123', merchant: 'Blue Bottle', amount: -6, accountId: 'card' });

  it('matches every condition that is set', () => {
    expect(ruleMatches(rule('r', { merchant: 'blue bottle' }), t)).toBe(true);
    expect(ruleMatches(rule('r', { merchant: 'sq *blue bottle 123' }), t)).toBe(true);
    expect(ruleMatches(rule('r', { merchant: 'Blue' }), t)).toBe(false);
    expect(ruleMatches(rule('r', { descriptionContains: 'blue bottle' }), t)).toBe(true);
    expect(ruleMatches(rule('r', { descriptionContains: 'blue', amountMin: -5 }), t)).toBe(false);
    expect(ruleMatches(rule('r', { amountMin: -10, amountMax: -5 }), t)).toBe(true);
  });

  it('matches merchant substrings against the merchant or the description', () => {
    expect(ruleMatches(rule('r', { merchantContains: 'BOTTLE' }), t)).toBe(true);
    expect(ruleMatches(rule('r', { merchantContains: 'sq *' }), t)).toBe(true);
    expect(ruleMatches(rule('r', { merchantContains: 'cafe' }), t)).toBe(false);
  });

  it('matches regular expressions case-insensitively', () => {
    expect(ruleMatches(rule('r', { descriptionRegex: '^sq \\*blue' }), t)).toBe(true);
    expect(ruleMatches(rule('r', { descriptionRegex: '\\d{4}' }), t)).toBe(false);
    expect(ruleMatches(rule('r', { merchantRegex: '^blue bottle$' }), t)).toBe(true);
    expect(ruleMatches(rule('r', { merchantRegex: '^bottle' }), t)).toBe(false);
  });

  it('never matches with an invalid regex', () => {
    expect(ruleMatches(rule('r', { descriptionRegex: '(' }), t)).toBe(false);
    expect(ruleMatches(rule('r', { merchantRegex: '[' }), t)).toBe(false);
  });

  it('matches an exact amount to the cent', () => {
    expect(ruleMatches(rule('r', { amountEquals: -6 }), t)).toBe(true);
    expect(ruleMatches(rule('r', { amountEquals: -6.001 }), t)).toBe(true);
    expect(ruleMatches(rule('r', { amountEquals: 6 }), t)).toBe(false);
    expect(ruleMatches(rule('r', { amountEquals: -6.01 }), tx('b', { amount: -6.01 }))).toBe(true);
  });

  it('matches an account', () => {
    expect(ruleMatches(rule('r', { accountId: 'card' }), t)).toBe(true);
    expect(ruleMatches(rule('r', { accountId: 'checking', merchant: 'Blue Bottle' }), t)).toBe(false);
  });

  it('never matches without conditions', () => {
    expect(hasConditions(rule('r', {}))).toBe(false);
    expect(ruleMatches(rule('r', { renameMerchant: 'X' }), t)).toBe(false);
  });

  it('falls back to the description when the merchant is missing', () => {
    const fresh = tx('c', { description: 'NETFLIX.COM', merchant: undefined });
    expect(ruleMatches(rule('r', { merchantContains: 'netflix' }), fresh)).toBe(true);
  });
});

describe('rule order', () => {
  const rules: Rule[] = [
    rule('big', { categoryId: 'shopping', descriptionContains: 'amzn', amountMax: -100 }),
    rule('any', { categoryId: 'groceries', descriptionContains: 'amzn', renameMerchant: 'Amazon' }),
  ];

  it('uses the first matching rule', () => {
    expect(findRule(rules, tx('AMZN Mktp', { amount: -150 }))?.id).toBe('big');
    expect(findRule(rules, tx('AMZN Fresh', { amount: -30 }))?.id).toBe('any');
    expect(findRule(rules, tx('Bakery'))).toBeUndefined();
  });

  it('lets the first match decide both category and merchant', () => {
    expect(applyRules(rules, tx('AMZN Mktp', { amount: -150 }))).toMatchObject({ categoryId: 'shopping', merchant: 'AMZN Mktp' });
    expect(applyRules(rules, tx('AMZN Fresh', { amount: -30 }))).toMatchObject({ categoryId: 'groceries', merchant: 'Amazon' });
  });

  it('changes the outcome when rules are reordered', () => {
    const swapped = moveRule(rules, 'any', -1);
    expect(swapped.map((r) => r.id)).toEqual(['any', 'big']);
    expect(applyRules(swapped, tx('AMZN Mktp', { amount: -150 })).categoryId).toBe('groceries');
  });

  it('moves rules up and down, clamping at the ends', () => {
    const three = [...rules, rule('c', { merchant: 'c' })];
    expect(moveRule(three, 'big', 1).map((r) => r.id)).toEqual(['any', 'big', 'c']);
    expect(moveRule(three, 'big', 5).map((r) => r.id)).toEqual(['any', 'c', 'big']);
    expect(moveRule(three, 'c', -1).map((r) => r.id)).toEqual(['big', 'c', 'any']);
    expect(moveRule(three, 'big', -1)).toBe(three);
    expect(moveRule(three, 'c', 1)).toBe(three);
    expect(moveRule(three, 'nope', 1)).toBe(three);
  });

  it('adds new rules last, replaces in place and removes', () => {
    const added = upsertRule(rules, rule('new', { merchant: 'x' }));
    expect(added.map((r) => r.id)).toEqual(['big', 'any', 'new']);
    const edited = upsertRule(added, rule('big', { merchant: 'y' }));
    expect(edited.map((r) => r.id)).toEqual(['big', 'any', 'new']);
    expect(edited[0].merchant).toBe('y');
    expect(removeRule(edited, 'any').map((r) => r.id)).toEqual(['big', 'new']);
  });
});

describe('applyRules', () => {
  const rules = [rule('r', { merchantContains: 'blue bottle', renameMerchant: 'Blue Bottle' })];

  it('returns the transaction itself when nothing matches or changes', () => {
    const none = tx('Bakery');
    expect(applyRules(rules, none)).toBe(none);
    const done = tx('BLUE BOTTLE 1', { categoryId: 'dining', merchant: 'Blue Bottle' });
    expect(applyRules(rules, done)).toBe(done);
  });

  it('never overrides a category or merchant the user edited', () => {
    const cat = tx('BLUE BOTTLE 1', { categoryEdited: true, categoryId: 'travel' });
    expect(applyRules(rules, cat)).toMatchObject({ categoryId: 'travel', merchant: 'Blue Bottle' });
    const merch = tx('BLUE BOTTLE 2', { merchant: 'My cafe', merchantEdited: true });
    expect(applyRules(rules, merch)).toMatchObject({ categoryId: 'dining', merchant: 'My cafe' });
    const both = tx('BLUE BOTTLE 3', { categoryEdited: true, merchantEdited: true });
    expect(applyRules(rules, both)).toBe(both);
  });

  it('ignores a blank rename', () => {
    expect(applyRules([rule('r', { merchant: 'a', renameMerchant: '  ' })], tx('a')).merchant).toBe('a');
  });
});

describe('previewRules and applyRulesToLedger', () => {
  const rules = [
    rule('coffee', { merchantContains: 'coffee', renameMerchant: 'Coffee' }),
    rule('rent', { categoryId: 'rent', amountEquals: -1650 }),
  ];
  const s = ledger([
    tx('JOE COFFEE'),
    tx('COFFEE BAR', { reviewed: true }),
    tx('LANDLORD', { amount: -1650 }),
    tx('COFFEE CO', { categoryEdited: true, merchantEdited: true }),
    tx('Bakery'),
  ], rules);

  it('lists what would change, skipping reviewed transactions by default', () => {
    const changes = previewRules(s);
    expect(changes.map((c) => [c.before.id, c.ruleId, c.after.categoryId])).toEqual([
      ['JOE COFFEE', 'coffee', 'dining'],
      ['LANDLORD', 'rent', 'rent'],
    ]);
    expect(previewRules(s, { includeReviewed: true })).toHaveLength(3);
  });

  it('applies exactly the previewed changes and keeps category names in step', () => {
    const next = applyRulesToLedger(s);
    expect(next.transactions.map((t) => [t.categoryId, t.category, t.merchant])).toEqual([
      ['dining', 'Dining', 'Coffee'],
      ['other', 'Other', 'COFFEE BAR'],
      ['rent', 'Rent', 'LANDLORD'],
      ['other', 'Other', 'COFFEE CO'],
      ['other', 'Other', 'Bakery'],
    ]);
    expect(next.transactions[4]).toBe(s.transactions[4]);
    expect(previewRules(next)).toEqual([]);
    expect(applyRulesToLedger(next)).toBe(next);
  });
});

describe('validateRule', () => {
  const { categories } = emptyLedger('2026-10');

  it('accepts a rule with a condition and a known category', () => {
    expect(validateRule(rule('r', { merchantRegex: '^uber' }), categories)).toBeUndefined();
  });

  it('explains what is wrong', () => {
    expect(validateRule(rule('r', {}), categories)).toMatch(/condition/);
    expect(validateRule(rule('r', { descriptionRegex: '(' }), categories)).toMatch(/Description pattern/);
    expect(validateRule(rule('r', { amountMin: 5, amountMax: 1 }), categories)).toMatch(/minimum/);
    expect(validateRule(rule('r', { amountEquals: NaN }), categories)).toMatch(/numbers/);
    expect(validateRule(rule('r', { merchant: 'x', categoryId: 'gone' }), categories)).toMatch(/category/);
  });

  it('checks regexes', () => {
    expect(isValidRegex('a+b')).toBe(true);
    expect(isValidRegex('a(')).toBe(false);
  });
});

describe('rule helpers', () => {
  it('tells merchant-only rules apart', () => {
    expect(isMerchantOnly(rule('r', { merchant: 'a' }))).toBe(true);
    expect(isMerchantOnly(rule('r', { merchant: 'a', renameMerchant: 'A' }))).toBe(true);
    expect(isMerchantOnly(rule('r', { merchant: 'a', accountId: 'x' }))).toBe(false);
    expect(isMerchantOnly(rule('r', { merchantContains: 'a' }))).toBe(false);
  });

  it('makes unique ids', () => {
    const first = newRuleId([], 'seed');
    expect(newRuleId([{ id: first, categoryId: 'x' }], 'seed')).not.toBe(first);
  });

  it('normalizes stored rules, dropping unusable ones and stray fields', () => {
    const known = new Set(['dining']);
    expect(normalizeRule({ id: 'r', categoryId: 'dining', merchant: ' ', amountMin: 'x', amountMax: -1, junk: 1 }, known))
      .toEqual({ id: 'r', categoryId: 'dining', amountMax: -1 });
    expect(normalizeRule({ id: 'r', categoryId: 'gone', merchant: 'a' }, known)).toBeUndefined();
    expect(normalizeRule(null, known)).toBeUndefined();
  });
});
