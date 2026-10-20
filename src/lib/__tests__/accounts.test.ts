import { describe, expect, it } from 'vitest';
import { groupAccounts, isLiability, netWorth, renameAccount, setAccountHidden } from '../accounts';
import { netWorthByMonth } from '../insights';
import type { Account, BalanceSnapshot, Transaction } from '../types';

const tx = (id: string, accountId: string, amount: number): Transaction =>
  ({ id, date: '2026-10-01', description: id, amount, category: 'Other', accountId });

const accounts: Account[] = [
  { id: 'chk', name: 'Checking', type: 'checking' },
  { id: 'sav', name: 'Savings', type: 'savings', balance: 1000 },
  { id: 'card', name: 'Card', type: 'credit' },
  { id: 'inv', name: 'Brokerage', type: 'investment', balance: 5000 },
  { id: 'car', name: 'Car loan', type: 'loan', balance: -8000 },
  { id: 'old', name: 'Old savings', type: 'savings', balance: 300, hidden: true },
];
const txns = [tx('t1', 'chk', 2000), tx('t2', 'chk', -150.25), tx('t3', 'card', -400), tx('t4', 'card', 100)];

describe('groupAccounts', () => {
  it('groups by type in display order with subtotals', () => {
    const groups = groupAccounts(accounts, txns);
    expect(groups.map((g) => [g.id, g.subtotal])).toEqual([
      ['cash', 2849.75], ['credit', -300], ['investments', 5000], ['loans', -8000],
    ]);
    expect(groups[0].accounts.map((r) => [r.account.id, r.balance])).toEqual([['chk', 1849.75], ['sav', 1000]]);
    expect(groups.map((g) => g.liability)).toEqual([false, true, false, true]);
  });

  it('uses the provider balance when present, else derives it from transactions', () => {
    const [cash] = groupAccounts([{ id: 'chk', name: 'C', type: 'checking', balance: 7 }, accounts[0]], txns);
    expect(cash.accounts.map((r) => r.balance)).toEqual([7, 1849.75]);
  });

  it('leaves hidden accounts out unless asked, and never counts them in subtotals', () => {
    expect(groupAccounts(accounts, txns)[0].accounts.map((r) => r.account.id)).not.toContain('old');
    const cash = groupAccounts(accounts, txns, { showHidden: true })[0];
    expect(cash.accounts.map((r) => r.account.id)).toContain('old');
    expect(cash.subtotal).toBe(2849.75);
  });

  it('skips empty groups', () => {
    expect(groupAccounts([accounts[2]], txns).map((g) => g.id)).toEqual(['credit']);
    expect(groupAccounts([], txns)).toEqual([]);
  });
});

describe('netWorth', () => {
  it('is assets minus liabilities, with cards and loans as liabilities', () => {
    expect(netWorth(accounts, txns)).toEqual({ assets: 7849.75, liabilities: 8300, netWorth: -450.25 });
  });

  it('excludes hidden accounts', () => {
    const all = accounts.map((a) => ({ ...a, hidden: a.id === 'car' }));
    expect(netWorth(all, txns)).toEqual({ assets: 8149.75, liabilities: 300, netWorth: 7849.75 });
  });

  it('treats an overpaid card as reducing liabilities', () => {
    expect(netWorth([{ id: 'c', name: 'C', type: 'credit', balance: 25 }], [])).toEqual({ assets: 0, liabilities: -25, netWorth: 25 });
  });

  it('classifies liabilities by type', () => {
    expect(['checking', 'savings', 'credit', 'investment', 'loan'].map((type) => isLiability({ type } as Account)))
      .toEqual([false, false, true, false, true]);
  });
});

describe('renameAccount', () => {
  it('trims, renames and flags the account', () => {
    const next = renameAccount(accounts, 'chk', '  Everyday  ');
    expect(next[0]).toEqual({ id: 'chk', name: 'Everyday', type: 'checking', renamed: true });
    expect(next[1]).toBe(accounts[1]);
    expect(accounts[0].name).toBe('Checking');
  });

  it('ignores blank names, unknown ids and no-op renames', () => {
    expect(renameAccount(accounts, 'chk', '   ')).toBe(accounts);
    expect(renameAccount(accounts, 'nope', 'X')).toBe(accounts);
    expect(renameAccount(accounts, 'chk', 'Checking')).toBe(accounts);
  });
});

describe('setAccountHidden', () => {
  it('hides and unhides', () => {
    const hidden = setAccountHidden(accounts, 'chk', true);
    expect(hidden[0].hidden).toBe(true);
    expect(setAccountHidden(hidden, 'chk', false)[0].hidden).toBe(false);
  });

  it('returns the same list when nothing changes', () => {
    expect(setAccountHidden(accounts, 'old', true)).toBe(accounts);
    expect(setAccountHidden(accounts, 'chk', false)).toBe(accounts);
    expect(setAccountHidden(accounts, 'nope', true)).toBe(accounts);
  });
});

describe('net worth edge cases', () => {
  it('is zero with no accounts', () => {
    expect(netWorth([], [])).toEqual({ assets: 0, liabilities: 0, netWorth: 0 });
  });
  it('can be negative when debts exceed assets', () => {
    const r = netWorth([
      { id: 'c', name: 'Checking', type: 'checking', balance: 1200.1 },
      { id: 's', name: 'Student loan', type: 'loan', balance: -20000.2 },
      { id: 'k', name: 'Card', type: 'credit' },
    ], [tx('k1', 'k', -300.05), tx('k2', 'k', -0.1)]);
    expect(r).toEqual({ assets: 1200.1, liabilities: 20300.35, netWorth: -19100.25 });
  });
  it('counts an overdrawn checking account against assets', () => {
    expect(netWorth([{ id: 'c', name: 'Checking', type: 'checking' }], [tx('o', 'c', -50)]))
      .toEqual({ assets: -50, liabilities: 0, netWorth: -50 });
  });
  it('rounds away floating point noise', () => {
    const r = netWorth([{ id: 'c', name: 'Checking', type: 'checking' }], [tx('a', 'c', 0.1), tx('b', 'c', 0.2)]);
    expect(r.netWorth).toBe(0.3);
  });
});

describe('netWorthByMonth', () => {
  const snap = (accountId: string, date: string, balance: number): BalanceSnapshot => ({ accountId, date, balance });
  const accts: Account[] = [
    { id: 'chk', name: 'Checking', type: 'checking' },
    { id: 'card', name: 'Card', type: 'credit' },
    { id: 'old', name: 'Old', type: 'savings', hidden: true },
  ];
  it('takes each account’s latest snapshot per month and carries it forward', () => {
    const points = netWorthByMonth(accts, [
      snap('chk', '2026-08-31', 1000),
      snap('card', '2026-08-15', -200),
      snap('chk', '2026-09-30', 1500),
      snap('card', '2026-10-01', -50),
      snap('chk', '2026-08-01', 900),
    ]);
    expect(points).toEqual([
      { month: '2026-08', total: 800 },
      { month: '2026-09', total: 1300 },
      { month: '2026-10', total: 1450 },
    ]);
  });
  it('leaves out hidden and unknown accounts', () => {
    expect(netWorthByMonth(accts, [snap('old', '2026-08-01', 5000), snap('gone', '2026-08-01', 1), snap('chk', '2026-08-02', 10)]))
      .toEqual([{ month: '2026-08', total: 10 }]);
  });
  it('is empty without snapshots', () => expect(netWorthByMonth(accts, [])).toEqual([]));
});
