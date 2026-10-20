import { describe, expect, it } from 'vitest';
import { netWorthByMonth } from '../insights';
import { emptyLedger } from '../migrate';
import { DEMO_SUBSCRIPTIONS, MockProvider, applySync, fetchSync } from '../sync';
import type { Transaction } from '../types';

const today = new Date(2026, 9, 20);
const MONTHS = [
  '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04',
  '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
];

async function generate(now = today, seed?: number) {
  const p = new MockProvider(now, seed);
  return { accounts: await p.listAccounts(), transactions: await p.fetchTransactions(), balances: await p.fetchBalances() };
}

const months = (txns: Transaction[]) => [...new Set(txns.map((t) => t.date.slice(0, 7)))].sort();

describe('demo data determinism', () => {
  it('is identical for the same today and seed', async () => {
    expect(await generate()).toEqual(await generate());
    expect(await generate(new Date(2026, 9, 20, 18, 45))).toEqual(await generate());
  });

  it('changes with the seed but keeps the fixed schedule', async () => {
    const a = await generate();
    const b = await generate(today, 7);
    expect(b.transactions).not.toEqual(a.transactions);
    const rent = (r: typeof a) => r.transactions.filter((t) => t.description === 'Maple Street Lofts').map((t) => t.date);
    expect(rent(b)).toEqual(rent(a));
  });

  it('anchors the window to the passed-in today', async () => {
    const { transactions } = await generate(new Date(2027, 2, 9));
    expect(transactions[0].date <= '2027-03-09').toBe(true);
    expect(transactions.at(-1)!.date).toBe('2026-04-01');
  });
});

describe('demo data contents', () => {
  it('has a checking, savings, credit card and investment account', async () => {
    const { accounts } = await generate();
    expect(accounts.map((a) => a.type)).toEqual(['checking', 'savings', 'credit', 'investment']);
    expect(new Set(accounts.map((a) => a.id)).size).toBe(4);
  });

  it('covers 12 months up to today, newest first, in every account', async () => {
    const { accounts, transactions } = await generate();
    expect(months(transactions)).toEqual(MONTHS);
    expect(transactions.at(-1)!.date).toBe('2025-11-01');
    expect(transactions[0].date <= '2026-10-20').toBe(true);
    expect(transactions.map((t) => t.date)).toEqual(transactions.map((t) => t.date).sort().reverse());
    expect(transactions.length).toBeGreaterThan(400);
    expect(transactions.length).toBeLessThan(800);
    for (const a of accounts) expect(transactions.some((t) => t.accountId === a.id)).toBe(true);
  });

  it('includes paychecks, rent, groceries and dining', async () => {
    const { transactions } = await generate();
    const named = (d: string) => transactions.filter((t) => t.description === d);
    expect(named('Brightwater Payroll')).toHaveLength(24);
    expect(named('Brightwater Payroll').every((t) => t.amount > 0 && t.category === 'Income')).toBe(true);
    expect(named('Maple Street Lofts')).toHaveLength(12);
    expect(named('Maple Street Lofts').every((t) => t.amount === -1650 && t.category === 'Rent')).toBe(true);
    for (const category of ['Groceries', 'Dining']) {
      const rows = transactions.filter((t) => t.category === category);
      expect(months(rows)).toEqual(MONTHS);
      expect(rows.every((t) => t.amount < 0)).toBe(true);
    }
  });

  it('has at least 5 monthly subscriptions with the same merchant and amount', async () => {
    const { transactions } = await generate();
    expect(DEMO_SUBSCRIPTIONS.length).toBeGreaterThanOrEqual(5);
    for (const [day, merchant, amount] of DEMO_SUBSCRIPTIONS) {
      const rows = transactions.filter((t) => t.description === merchant);
      expect(new Set(rows.map((t) => t.amount))).toEqual(new Set([-amount]));
      expect(new Set(rows.map((t) => t.accountId)).size).toBe(1);
      expect(rows.every((t) => Number(t.date.slice(8)) === day)).toBe(true);
      // One charge per month; this month's has not happened yet if its day is after today.
      expect(months(rows)).toEqual(day <= 20 ? MONTHS : MONTHS.slice(0, -1));
      expect(rows).toHaveLength(months(rows).length);
    }
  });

  it('balances transfers between the demo accounts', async () => {
    const { transactions } = await generate();
    const transfers = transactions.filter((t) => t.category === 'Transfer');
    expect(transfers.length).toBeGreaterThan(0);
    expect(Math.round(transfers.reduce((s, t) => s + t.amount, 0) * 100)).toBe(0);
  });
});

describe('demo balance snapshots', () => {
  it('has one snapshot per account at each month end and today, oldest first', async () => {
    const { accounts, balances } = await generate();
    expect(balances).toHaveLength(4 * 12);
    const dates = [...new Set(balances.map((b) => b.date))];
    expect(dates).toEqual([
      '2025-11-30', '2025-12-31', '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30',
      '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-20',
    ]);
    for (const d of dates) expect(balances.filter((b) => b.date === d).map((b) => b.accountId)).toEqual(accounts.map((a) => a.id));
  });

  it('moves cash accounts by exactly their transactions between snapshots', async () => {
    const { transactions, balances } = await generate();
    for (const id of ['demo-checking', 'demo-savings', 'demo-card']) {
      const series = balances.filter((b) => b.accountId === id);
      series.slice(1).forEach((b, i) => {
        const prev = series[i];
        const moved = transactions
          .filter((t) => t.accountId === id && t.date > prev.date! && t.date <= b.date!)
          .reduce((s, t) => s + t.amount, 0);
        expect(b.balance - prev.balance).toBeCloseTo(moved, 2);
      });
    }
  });

  it('becomes account balances, demo-tagged snapshots and a 12-month net worth trend when synced', async () => {
    const p = new MockProvider(today);
    const { state } = applySync(emptyLedger('2026-10'), p.id, await fetchSync(p, emptyLedger('2026-10')), today);
    const latest = (await p.fetchBalances()).filter((b) => b.date === '2026-10-20');
    expect(state.accounts.map((a) => a.balance)).toEqual(latest.map((b) => b.balance));
    expect(state.balanceSnapshots).toHaveLength(48);
    expect([...state.accounts, ...state.transactions, ...state.balanceSnapshots].every((r) => r.source === 'demo')).toBe(true);

    const trend = netWorthByMonth(state.accounts, state.balanceSnapshots);
    expect(trend.map((t) => t.month)).toEqual(MONTHS);
    expect(trend.at(-1)!.total).toBeCloseTo(latest.reduce((s, b) => s + b.balance, 0), 2);

    const again = applySync(state, p.id, await fetchSync(new MockProvider(today), state), today);
    expect(again).toMatchObject({ added: 0, updated: 0 });
    expect(again.state.balanceSnapshots).toHaveLength(48);
  });
});
