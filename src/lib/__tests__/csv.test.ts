import { describe, expect, it } from 'vitest';
import { normalizeDate, parseAmount, parseCsvRows, parseTransactionsCsv } from '../csv';

describe('parseCsvRows', () => {
  it('handles quotes, escaped quotes, CRLF and blank lines', () => {
    expect(parseCsvRows('a,"b, c","say ""hi"""\r\n\r\n1,2,3')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', '2', '3'],
    ]);
  });
});

describe('field parsers', () => {
  it('normalizes dates', () => {
    expect(normalizeDate('2026-3-7')).toBe('2026-03-07');
    expect(normalizeDate('03/07/2026')).toBe('2026-03-07');
    expect(normalizeDate('2026-02-30')).toBeNull();
    expect(normalizeDate('yesterday')).toBeNull();
  });
  it('parses amounts', () => {
    expect(parseAmount('$1,234.50')).toBe(1234.5);
    expect(parseAmount('(45.00)')).toBe(-45);
    expect(parseAmount('-12')).toBe(-12);
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('parseTransactionsCsv', () => {
  const csv = [
    'date,description,amount,category,account',
    '2026-09-01,Corner Bakery,-4.50,Dining,Main Card',
    '2026-09-01,Corner Bakery,-4.50,Dining,Main Card',
    '2026-09-02,Paycheck,2000,Income,Checking',
    'bad-date,Oops,-1,Other,Checking',
  ].join('\n');

  it('parses rows, creates accounts and counts skipped rows', () => {
    const r = parseTransactionsCsv(csv);
    expect(r.transactions).toHaveLength(3);
    expect(r.skipped).toBe(1);
    expect(r.accounts.map((a) => a.id).sort()).toEqual(['csv-checking', 'csv-main-card']);
    expect(r.transactions[2]).toMatchObject({ amount: 2000, category: 'Income', accountId: 'csv-checking' });
  });

  it('gives stable ids, keeping genuine same-day repeats distinct', () => {
    const a = parseTransactionsCsv(csv).transactions.map((t) => t.id);
    const b = parseTransactionsCsv(csv).transactions.map((t) => t.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(3);
  });

  it('respects header column order and works without a header', () => {
    const reordered = parseTransactionsCsv('account,amount,date,description\nCard,-3,2026-01-02,Tea');
    expect(reordered.transactions[0]).toMatchObject({ description: 'Tea', amount: -3, category: 'Other', accountId: 'csv-card' });
    const noHeader = parseTransactionsCsv('2026-01-02,Tea,-3,Dining,Card');
    expect(noHeader.transactions[0].id).toBe(reordered.transactions[0].id);
  });
});
