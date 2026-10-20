import { describe, expect, it } from 'vitest';
import { normalizeDate, parseAmount, parseCsvRows, parseTransactionsCsv } from '../csv';

describe('parseCsvRows', () => {
  it('handles quotes, escaped quotes, CRLF and blank lines', () => {
    expect(parseCsvRows('a,"b, c","say ""hi"""\r\n\r\n1,2,3')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', '2', '3'],
    ]);
  });
  it('strips a byte order mark and keeps newlines inside quotes', () => {
    expect(parseCsvRows('\uFEFFDate,Memo\n2026-01-01,"line one\nline two"\n')).toEqual([
      ['Date', 'Memo'],
      ['2026-01-01', 'line one\nline two'],
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
  it.each([
    ['2026-10-03', '2026-10-03'],
    ['2026/10/03', '2026-10-03'],
    ['2026-10-03T14:20:00Z', '2026-10-03'],
    ['10/03/2026', '2026-10-03'],
    ['1/5/26', '2026-01-05'],
    ['12/31/99', '1999-12-31'],
    ['1-5-2026', '2026-01-05'],
    ['03 Oct 2026', '2026-10-03'],
    ['3 October 2026', '2026-10-03'],
    ['03-Sept-26', '2026-09-03'],
    ['Oct 3, 2026', '2026-10-03'],
  ])('reads %s', (raw, iso) => expect(normalizeDate(raw)).toBe(iso));
  it.each(['31 Foo 2026', '13/01/2026', '2/29/2025', '', '3 Ma 2026'])('rejects %j', (raw) =>
    expect(normalizeDate(raw)).toBeNull());
  it('parses amounts', () => {
    expect(parseAmount('$1,234.50')).toBe(1234.5);
    expect(parseAmount('(45.00)')).toBe(-45);
    expect(parseAmount('-12')).toBe(-12);
    expect(parseAmount('abc')).toBeNull();
  });
  it.each([
    ['-$1,234.56', -1234.56],
    ['$-12.00', -12],
    ['($1,000.00)', -1000],
    ['€ 9.99', 9.99],
    ['£1,000', 1000],
    ['12.50 USD', 12.5],
    ['1,234.56-', -1234.56],
    ['+3', 3],
    ['.5', 0.5],
  ])('parses %s', (raw, n) => expect(parseAmount(raw)).toBe(n));
  it.each(['', '$', '()', '1.2.3', '12abc'])('rejects %j', (raw) => expect(parseAmount(raw)).toBeNull());
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
