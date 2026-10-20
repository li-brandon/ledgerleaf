import { describe, expect, it } from 'vitest';
import { CsvImportProvider, MockProvider, hashId, mergeSync } from '../sync';

const now = new Date(2026, 9, 20);

describe('hashId', () => {
  it('is deterministic and sensitive to input', () => {
    expect(hashId('abc')).toBe(hashId('abc'));
    expect(hashId('abc')).not.toBe(hashId('abd'));
  });
});

describe('MockProvider', () => {
  it('produces 3 accounts and ~4 months of deterministic data', async () => {
    const a = await new MockProvider(now).sync();
    const b = await new MockProvider(now).sync();
    expect(a.accounts).toHaveLength(3);
    expect(a.transactions).toEqual(b.transactions);
    const months = new Set(a.transactions.map((t) => t.date.slice(0, 7)));
    expect([...months].sort()).toEqual(['2026-07', '2026-08', '2026-09', '2026-10']);
    expect(a.transactions.every((t) => t.date <= '2026-10-20')).toBe(true);
    expect(new Set(a.transactions.map((t) => t.id)).size).toBe(a.transactions.length);
  });
});

describe('mergeSync', () => {
  it('dedupes by id and preserves existing edits', async () => {
    const first = mergeSync({ accounts: [], transactions: [] }, await new MockProvider(now).sync());
    expect(first.added).toBe(first.transactions.length);
    const edited = { ...first, transactions: first.transactions.map((t, i) => (i === 0 ? { ...t, category: 'Travel' } : t)) };
    const again = mergeSync(edited, await new MockProvider(now).sync());
    expect(again.added).toBe(0);
    expect(again.transactions).toHaveLength(first.transactions.length);
    expect(again.transactions[0].category).toBe('Travel');
  });

  it('dedupes repeated CSV imports and keeps derived balances', async () => {
    const csv = 'date,description,amount,category,account\n2026-10-01,Tea,-3,Dining,Card';
    const once = mergeSync({ accounts: [], transactions: [] }, await new CsvImportProvider(csv).sync());
    const twice = mergeSync(once, await new CsvImportProvider(csv).sync());
    expect(twice.added).toBe(0);
    expect(twice.accounts).toHaveLength(1);
    expect(twice.accounts[0].balance).toBeUndefined();
  });

  it('sorts transactions newest first', () => {
    const t = (id: string, date: string) => ({ id, date, description: id, amount: -1, category: 'Other', accountId: 'x' });
    const r = mergeSync({ accounts: [], transactions: [t('a', '2026-01-01')] }, { accounts: [], transactions: [t('b', '2026-02-01')] });
    expect(r.transactions.map((x) => x.id)).toEqual(['b', 'a']);
  });
});
