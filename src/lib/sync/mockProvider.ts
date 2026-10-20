import { hashId } from './hash';
import { localIsoDate } from './run';
import type { Account, Transaction } from '../types';
import type { AccountBalance, ProviderMeta, SyncProvider } from './types';

/** Deterministic PRNG so demo data is stable for a given seed. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACCOUNTS: Account[] = [
  { id: 'demo-checking', name: 'Fernway Checking', type: 'checking' },
  { id: 'demo-card', name: 'Canopy Rewards Card', type: 'credit' },
  { id: 'demo-savings', name: 'Rainy Day Savings', type: 'savings' },
];

const BALANCES: Record<string, number> = { 'demo-checking': 4210.55, 'demo-card': -812.4, 'demo-savings': 12500 };

export const MOCK_PROVIDER: ProviderMeta = {
  id: 'mock',
  name: 'Demo Bank (sample data)',
  kind: 'demo',
  requiresAuth: false,
  description: 'Three sample accounts with about four months of activity. Safe to re-sync; nothing is duplicated.',
};

type Daily = [category: string, merchants: string[], chance: number, min: number, max: number, account: string];
const DAILY: Daily[] = [
  ['Groceries', ['Green Basket Market', 'Harvest Co-op'], 0.25, 25, 130, 'demo-checking'],
  ['Dining', ['Juniper Café', 'Nori House', 'Slice & Co'], 0.35, 9, 60, 'demo-card'],
  ['Transport', ['Metro Transit', 'Zip Rideshare', 'Fuel Stop'], 0.2, 3, 55, 'demo-card'],
  ['Shopping', ['Bookbarn', 'Northwind Outfitters', 'Hearth Home'], 0.1, 15, 160, 'demo-card'],
  ['Entertainment', ['Cinema Lux', 'Arcadia Games'], 0.05, 12, 45, 'demo-card'],
  ['Health', ['Pillbox Pharmacy'], 0.04, 8, 70, 'demo-checking'],
];

/**
 * Demo provider: 3 accounts and ~4 months (current + 3 prior) of transactions up to `now`.
 * Each day is generated from its own seed, so a day's transactions (and their ids) are the
 * same whichever window they fall in.
 */
export class MockProvider implements SyncProvider {
  readonly id = MOCK_PROVIDER.id;
  readonly name = MOCK_PROVIDER.name;
  readonly kind = MOCK_PROVIDER.kind;
  readonly requiresAuth = MOCK_PROVIDER.requiresAuth;
  readonly description = MOCK_PROVIDER.description;

  constructor(private now: Date = new Date(), private seed = 42) {}

  async listAccounts(): Promise<Account[]> {
    return ACCOUNTS.map((a) => ({ ...a }));
  }

  async fetchBalances(): Promise<AccountBalance[]> {
    return ACCOUNTS.map((a) => ({ accountId: a.id, balance: BALANCES[a.id], date: localIsoDate(this.now) }));
  }

  async fetchTransactions(since?: string): Promise<Transaction[]> {
    const txns: Transaction[] = [];
    const end = new Date(this.now.getFullYear(), this.now.getMonth(), this.now.getDate());
    for (let d = new Date(end.getFullYear(), end.getMonth() - 3, 1); d <= end; d.setDate(d.getDate() + 1)) {
      const date = localIsoDate(d);
      if (since && date < since) continue;
      const rand = mulberry32(this.seed ^ parseInt(hashId(date), 36));
      const between = (a: number, b: number) => Math.round((a + rand() * (b - a)) * 100) / 100;
      let n = 0;
      const add = (description: string, amount: number, category: string, accountId: string) => {
        const externalId = hashId(`${date}|${description}|${n++}`);
        txns.push({ id: `mock-${externalId}`, externalId, date, description, amount, category, accountId });
      };
      const day = d.getDate();
      if (day === 1) add('Maple Street Lofts', -1650, 'Rent', 'demo-checking');
      if (day === 1 || day === 15) add('Brightwater Payroll', 2900, 'Income', 'demo-checking');
      if (day === 5) add('City Power & Water', -between(90, 140), 'Utilities', 'demo-checking');
      if (day === 12) add('Streamly', -15.99, 'Entertainment', 'demo-card');
      if (day === 15) {
        add('Transfer to Rainy Day Savings', -500, 'Transfer', 'demo-checking');
        add('Transfer from Fernway Checking', 500, 'Transfer', 'demo-savings');
      }
      for (const [category, merchants, chance, min, max, account] of DAILY) {
        if (rand() < chance) add(merchants[Math.floor(rand() * merchants.length)], -between(min, max), category, account);
      }
    }
    return txns.reverse();
  }
}
