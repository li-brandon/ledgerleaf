import { hashId } from './hash';
import { localIsoDate } from './run';
import type { Account, Transaction } from '../types';
import type { AccountBalance, ProviderMeta, SyncProvider } from './types';

/** Source stamped on every demo account, transaction and balance snapshot. */
export const DEMO_SOURCE = 'demo';
/** Source the demo provider used before it was renamed; still counted as demo data. */
export const LEGACY_DEMO_SOURCE = 'mock';
export const isDemoSource = (source?: string) => source === DEMO_SOURCE || source === LEGACY_DEMO_SOURCE;

/** Months of history generated, counting the current (partial) month. */
export const DEMO_MONTHS = 12;

/** Deterministic PRNG so demo data is stable for a given seed. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
const lastDayOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

const CHECKING = 'demo-checking';
const SAVINGS = 'demo-savings';
const CARD = 'demo-card';
const INVEST = 'demo-invest';

const ACCOUNTS: Account[] = [
  { id: CHECKING, name: 'Fernway Checking', type: 'checking', institution: 'Fernway Bank' },
  { id: SAVINGS, name: 'Rainy Day Savings', type: 'savings', institution: 'Fernway Bank' },
  { id: CARD, name: 'Canopy Rewards Card', type: 'credit', institution: 'Canopy' },
  { id: INVEST, name: 'Evergreen Brokerage', type: 'investment', institution: 'Evergreen' },
];

/** Balances the day before the first generated day (the card's comes from last month's spending). */
const OPENING: Record<string, number> = { [CHECKING]: 3200, [SAVINGS]: 9000, [INVEST]: 18000 };

export const MOCK_PROVIDER: ProviderMeta = {
  id: DEMO_SOURCE,
  name: 'Demo Bank (sample data)',
  kind: 'demo',
  requiresAuth: false,
  description: 'Four sample accounts (checking, savings, card, investment) with a year of activity, monthly balances and recurring subscriptions. Safe to re-sync; nothing is duplicated.',
};

/** Same merchant, same amount, same day every month: signal for recurring detection. */
export const DEMO_SUBSCRIPTIONS: [day: number, merchant: string, amount: number, category: string, account: string][] = [
  [3, 'Tunebox Music', 10.99, 'Entertainment', CARD],
  [7, 'FitLoop Gym', 39, 'Health', CARD],
  [12, 'Streamly', 15.99, 'Entertainment', CARD],
  [18, 'Daily Ledger News', 8, 'Other', CARD],
  [22, 'Cloudvault Storage', 2.99, 'Utilities', CARD],
  [26, 'Hearthline Mobile', 45, 'Utilities', CHECKING],
];

type Daily = [category: string, merchants: string[], chance: number, min: number, max: number, account: string];
const DAILY: Daily[] = [
  ['Groceries', ['Green Basket Market', 'Harvest Co-op'], 0.25, 25, 130, CHECKING],
  ['Dining', ['Juniper Café', 'Nori House', 'Slice & Co'], 0.35, 9, 60, CARD],
  ['Transport', ['Metro Transit', 'Zip Rideshare', 'Fuel Stop'], 0.2, 3, 55, CARD],
  ['Shopping', ['Bookbarn', 'Northwind Outfitters', 'Hearth Home'], 0.1, 15, 160, CARD],
  ['Entertainment', ['Cinema Lux', 'Arcadia Games'], 0.05, 12, 45, CARD],
  ['Health', ['Pillbox Pharmacy'], 0.04, 8, 70, CHECKING],
];

/**
 * Demo provider: 4 accounts and {@link DEMO_MONTHS} months of transactions up to `now`,
 * with an end-of-month balance snapshot per account (and one for today).
 *
 * Every transaction depends only on its date and the seed, so a day's transactions (and
 * their ids) are the same whichever window they fall in and re-syncs never duplicate.
 * Balances run forward from fixed opening balances at the start of the window; the
 * investment account also moves with a seeded monthly market return.
 */
export class MockProvider implements SyncProvider {
  readonly id = MOCK_PROVIDER.id;
  readonly name = MOCK_PROVIDER.name;
  readonly kind = MOCK_PROVIDER.kind;
  readonly requiresAuth = MOCK_PROVIDER.requiresAuth;
  readonly description = MOCK_PROVIDER.description;
  private days = new Map<string, Transaction[]>();
  private generated?: { transactions: Transaction[]; balances: AccountBalance[] };

  constructor(private now: Date = new Date(), private seed = 42) {}

  async listAccounts(): Promise<Account[]> {
    return ACCOUNTS.map((a) => ({ ...a }));
  }

  /** End-of-month balances, oldest first; the last one per account is today's. */
  async fetchBalances(): Promise<AccountBalance[]> {
    return this.generate().balances.map((b) => ({ ...b }));
  }

  async fetchTransactions(since?: string): Promise<Transaction[]> {
    return this.generate().transactions.filter((t) => !since || t.date >= since).map((t) => ({ ...t }));
  }

  private rand(key: string) {
    return mulberry32(this.seed ^ parseInt(hashId(key), 36));
  }

  /** Card spending (positive) over the calendar month before `d`. */
  private cardSpendBefore(d: Date) {
    let total = 0;
    const end = new Date(d.getFullYear(), d.getMonth(), 0);
    for (let p = new Date(end.getFullYear(), end.getMonth(), 1); p <= end; p.setDate(p.getDate() + 1)) {
      for (const t of this.activity(p)) if (t.accountId === CARD && t.category !== 'Transfer') total -= t.amount;
    }
    return round(total);
  }

  /** Everything dated `d`: the card statement payment on the 8th, then the day's activity. */
  private day(d: Date): Transaction[] {
    if (d.getDate() !== 8) return this.activity(d);
    const statement = this.cardSpendBefore(d);
    if (statement <= 0) return this.activity(d);
    const date = localIsoDate(d);
    const row = (description: string, amount: number, accountId: string): Transaction => {
      const externalId = hashId(`${date}|${description}|payment`);
      return { id: `${DEMO_SOURCE}-${externalId}`, externalId, date, description, amount, category: 'Transfer', accountId };
    };
    return [
      row('Canopy Card Payment', -statement, CHECKING),
      row('Payment received, thank you', statement, CARD),
      ...this.activity(d),
    ];
  }

  /** Everything dated `d` except the card payment, in a fixed order. */
  private activity(d: Date): Transaction[] {
    const date = localIsoDate(d);
    const cached = this.days.get(date);
    if (cached) return cached;

    const txns: Transaction[] = [];
    const rand = this.rand(date);
    const between = (a: number, b: number) => round(a + rand() * (b - a));
    let n = 0;
    const add = (description: string, amount: number, category: string, accountId: string) => {
      const externalId = hashId(`${date}|${description}|${n++}`);
      txns.push({ id: `${DEMO_SOURCE}-${externalId}`, externalId, date, description, amount, category, accountId });
    };
    const transfer = (from: string, to: string, amount: number, out: string, into: string) => {
      add(out, -amount, 'Transfer', from);
      add(into, amount, 'Transfer', to);
    };

    const day = d.getDate();
    const month = d.getMonth() + 1;
    if (day === 1) add('Maple Street Lofts', -1650, 'Rent', CHECKING);
    if (day === 1 || day === 15) add('Brightwater Payroll', 2900, 'Income', CHECKING);
    if (day === 5) add('City Power & Water', -between(90, 140), 'Utilities', CHECKING);
    if (day === 15) transfer(CHECKING, SAVINGS, 600, 'Transfer to Rainy Day Savings', 'Transfer from Fernway Checking');
    if (day === 20) transfer(CHECKING, INVEST, 750, 'Evergreen Brokerage contribution', 'Contribution from Fernway Checking');
    if (day === 28 && month % 3 === 0) add('Dividend reinvested', between(45, 95), 'Income', INVEST);
    if (day === lastDayOfMonth(d)) add('Interest paid', between(15, 28), 'Income', SAVINGS);
    for (const [on, merchant, amount, category, account] of DEMO_SUBSCRIPTIONS) {
      if (day === on) add(merchant, -amount, category, account);
    }
    for (const [category, merchants, chance, min, max, account] of DAILY) {
      if (rand() < chance) add(merchants[Math.floor(rand() * merchants.length)], -between(min, max), category, account);
    }

    this.days.set(date, txns);
    return txns;
  }

  private generate() {
    if (this.generated) return this.generated;
    const end = new Date(this.now.getFullYear(), this.now.getMonth(), this.now.getDate());
    const start = new Date(end.getFullYear(), end.getMonth() - (DEMO_MONTHS - 1), 1);
    const running: Record<string, number> = { ...OPENING, [CARD]: -this.cardSpendBefore(start) };
    const transactions: Transaction[] = [];
    const balances: AccountBalance[] = [];

    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      for (const t of this.day(d)) {
        transactions.push(t);
        running[t.accountId] = round(running[t.accountId] + t.amount);
      }
      const monthEnd = d.getDate() === lastDayOfMonth(d);
      if (monthEnd) {
        const r = this.rand(`market|${localIsoDate(d).slice(0, 7)}`)();
        running[INVEST] = round(running[INVEST] * (1 + (-0.03 + r * 0.075)));
      }
      if (monthEnd || d.getTime() === end.getTime()) {
        const date = localIsoDate(d);
        for (const a of ACCOUNTS) balances.push({ accountId: a.id, balance: running[a.id], date });
      }
    }
    return (this.generated = { transactions: transactions.reverse(), balances });
  }
}
