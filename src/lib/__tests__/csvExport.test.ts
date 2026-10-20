import { describe, expect, it } from 'vitest';
import { parseCsvRows } from '../csv';
import { CSV_COLUMNS, csvCell, transactionsToCsv } from '../csvExport';
import { EMPTY_FILTERS, applyFilters } from '../txFilters';
import type { Account, Transaction } from '../types';

const accounts: Account[] = [
  { id: 'a1', name: 'Fernway Checking', type: 'checking', currency: 'USD' },
  { id: 'a2', name: 'Euro, Card', type: 'credit', currency: 'EUR' },
];

const tx = (p: Partial<Transaction> & Pick<Transaction, 'id' | 'date' | 'amount'>): Transaction => ({
  description: 'Shop', category: 'Shopping', categoryId: 'shopping', accountId: 'a1', ...p,
});

const rows: Transaction[] = [
  tx({ id: 't1', date: '2026-10-03', amount: -12.3, description: 'Bean "There", Cafe', merchant: 'Bean There', category: 'Dining', reviewed: true }),
  tx({ id: 't2', date: '2026-10-02', amount: 2900, description: 'Payroll', category: 'Income', notes: 'line one\nline two' }),
  tx({ id: 't3', date: '2026-09-30', amount: -0.1 - 0.2, description: '=HYPERLINK("x")', accountId: 'a2' }),
];

describe('csvCell', () => {
  it('leaves plain text alone', () => expect(csvCell('Green Basket')).toBe('Green Basket'));

  it('quotes commas, quotes, line breaks and edge spaces', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell(' pad')).toBe('" pad"');
  });

  it('defuses spreadsheet formulas', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('@x')).toBe("'@x");
  });
});

describe('transactionsToCsv', () => {
  const csv = transactionsToCsv(rows, accounts);
  const parsed = parseCsvRows(csv);

  it('writes a header and one row per transaction with CRLF endings', () => {
    expect(csv.startsWith(`${CSV_COLUMNS.join(',')}\r\n`)).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(parsed).toHaveLength(rows.length + 1);
  });

  it('round-trips through the CSV parser', () => {
    expect(parsed[1]).toEqual(['2026-10-03', 'Bean "There", Cafe', 'Bean There', 'Dining', 'Fernway Checking', '-12.30', 'USD', '', 'yes', 't1']);
    expect(parsed[2][7]).toBe('line one\nline two');
    expect(parsed[2][5]).toBe('2900.00');
  });

  it('rounds amounts to cents, uses the account currency and defuses formulas', () => {
    expect(parsed[3]).toEqual(['2026-09-30', "'=HYPERLINK(\"x\")", '', 'Shopping', 'Euro, Card', '-0.30', 'EUR', '', 'no', 't3']);
  });

  it('falls back to the account id and the given currency for unknown accounts', () => {
    const out = parseCsvRows(transactionsToCsv([tx({ id: 'x', date: '2026-01-01', amount: -1, accountId: 'gone' })], [], 'GBP'));
    expect(out[1][4]).toBe('gone');
    expect(out[1][6]).toBe('GBP');
  });

  it('exports only the filtered rows when given them', () => {
    const filtered = applyFilters(rows, { ...EMPTY_FILTERS, kind: 'expense', from: '2026-10-01' });
    const out = parseCsvRows(transactionsToCsv(filtered, accounts));
    expect(out.slice(1).map((r) => r[9])).toEqual(['t1']);
  });

  it('writes only a header for no rows', () => {
    expect(transactionsToCsv([], accounts)).toBe(`${CSV_COLUMNS.join(',')}\r\n`);
  });
});
