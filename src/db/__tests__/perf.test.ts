import { describe, expect, it } from 'vitest';
import { readLedger, saveLedger } from '../ledger';
import { emptyLedger } from '../../lib/migrate';
import { ADAPTERS, makeTransactions } from './helpers';

const N = 5000;

describe.each(ADAPTERS)('%s performance', (_, open) => {
  it(`saves and loads ${N} transactions in under 1000ms`, async () => {
    const repo = await open();
    const state = { ...emptyLedger('2026-10'), transactions: makeTransactions(N) };

    const start = performance.now();
    await saveLedger(repo, state);
    const loaded = await readLedger(repo);
    const elapsed = performance.now() - start;

    expect(loaded?.transactions).toHaveLength(N);
    expect(elapsed).toBeLessThan(1000);
  });
});
