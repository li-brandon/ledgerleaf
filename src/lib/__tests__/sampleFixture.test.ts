import { describe, expect, it } from 'vitest';
import { applyMapping, detectMapping, readCsvTable } from '../csvMapping';
import sample from '../../../fixtures/sample-transactions.csv?raw';

/** The sample file the README points people at must import cleanly through the real importer. */
describe('fixtures/sample-transactions.csv', () => {
  const table = readCsvTable(sample);

  it('is detected as a Date,Description,Amount,Category export', () => {
    expect(table.hasHeader).toBe(true);
    expect(detectMapping(table.headers)).toEqual({
      date: 'Date', description: 'Description', amount: 'Amount', category: 'Category',
    });
  });

  it('parses every row without errors', () => {
    const { transactions, errors } = applyMapping(table, detectMapping(table.headers), 'csv-sample');
    expect(errors).toEqual([]);
    expect(transactions).toHaveLength(15);
    expect(new Set(transactions.map((t) => t.id)).size).toBe(15);
    expect(transactions[0]).toMatchObject({
      date: '2026-09-01', description: 'Brightwater Payroll', amount: 2900, category: 'Income', accountId: 'csv-sample',
    });
    expect(transactions.find((t) => t.description === 'Bookbarn, Downtown')?.amount).toBe(-24.75);
  });
});
