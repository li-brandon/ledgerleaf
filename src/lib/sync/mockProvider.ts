import { hashId } from './hash';
import type { Account, Transaction } from '../types';
import type { SyncProvider, SyncResult } from './types';

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
  { id: 'demo-checking', name: 'Fernway Checking', type: 'checking', balance: 4210.55 },
  { id: 'demo-card', name: 'Canopy Rewards Card', type: 'credit', balance: -812.4 },
  { id: 'demo-savings', name: 'Rainy Day Savings', type: 'savings', balance: 12500 },
];

type Daily = [category: string, merchants: string[], chance: number, min: number, max: number, account: string];
const DAILY: Daily[] = [
  ['Groceries', ['Green Basket Market', 'Harvest Co-op'], 0.25, 25, 130, 'demo-checking'],
  ['Dining', ['Juniper Café', 'Nori House', 'Slice & Co'], 0.35, 9, 60, 'demo-card'],
  ['Transport', ['Metro Transit', 'Zip Rideshare', 'Fuel Stop'], 0.2, 3, 55, 'demo-card'],
  ['Shopping', ['Bookbarn', 'Northwind Outfitters', 'Hearth Home'], 0.1, 15, 160, 'demo-card'],
  ['Entertainment', ['Cinema Lux', 'Arcadia Games'], 0.05, 12, 45, 'demo-card'],
  ['Health', ['Pillbox Pharmacy'], 0.04, 8, 70, 'demo-checking'],
];

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Demo provider: 3 accounts and ~4 months (current + 3 prior) of transactions up to `now`. */
export class MockProvider implements SyncProvider {
  id = 'mock';
  name = 'Demo Bank (sample data)';
  constructor(private now: Date = new Date(), private seed = 42) {}

  async sync(): Promise<SyncResult> {
    const rand = mulberry32(this.seed);
    const between = (a: number, b: number) => Math.round((a + rand() * (b - a)) * 100) / 100;
    const txns: Transaction[] = [];
    const add = (date: string, description: string, amount: number, category: string, accountId: string) =>
      txns.push({ id: `mock-${hashId(`${date}|${description}|${txns.length}`)}`, date, description, amount, category, accountId });

    const end = new Date(this.now.getFullYear(), this.now.getMonth(), this.now.getDate());
    for (let d = new Date(end.getFullYear(), end.getMonth() - 3, 1); d <= end; d.setDate(d.getDate() + 1)) {
      const date = iso(d);
      const day = d.getDate();
      if (day === 1) add(date, 'Maple Street Lofts', -1650, 'Rent', 'demo-checking');
      if (day === 1 || day === 15) add(date, 'Brightwater Payroll', 2900, 'Income', 'demo-checking');
      if (day === 5) add(date, 'City Power & Water', -between(90, 140), 'Utilities', 'demo-checking');
      if (day === 12) add(date, 'Streamly', -15.99, 'Entertainment', 'demo-card');
      if (day === 15) {
        add(date, 'Transfer to Rainy Day Savings', -500, 'Transfer', 'demo-checking');
        add(date, 'Transfer from Fernway Checking', 500, 'Transfer', 'demo-savings');
      }
      for (const [category, merchants, chance, min, max, account] of DAILY) {
        if (rand() < chance) add(date, merchants[Math.floor(rand() * merchants.length)], -between(min, max), category, account);
      }
    }
    return { accounts: ACCOUNTS.map((a) => ({ ...a })), transactions: txns.reverse() };
  }
}
