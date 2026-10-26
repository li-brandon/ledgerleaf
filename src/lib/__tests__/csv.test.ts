import { describe, expect, it } from 'vitest';
import { detectDecimal, normalizeDate, parseAmount, parseCsvRows, parseTransactionsCsv, readAmount } from '../csv';

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
  it('keeps a quote inside an unquoted cell literal instead of swallowing the rest of the file', () => {
    expect(parseCsvRows('date,description,amount\n2026-10-01,JOE\'S 12" PIZZA,-5\n2026-10-02,Coffee,-3\n')).toEqual([
      ['date', 'description', 'amount'],
      ['2026-10-01', 'JOE\'S 12" PIZZA', '-5'],
      ['2026-10-02', 'Coffee', '-3'],
    ]);
    expect(parseCsvRows('a,b"c"d,""\n')).toEqual([['a', 'b"c"d', '']]);
    expect(parseTransactionsCsv('date,description,amount\n2026-10-01,12" SUB,-5\n2026-10-02,Coffee,-3').transactions).toHaveLength(2);
  });
  it('ends an unterminated quoted cell at the end of the text', () => {
    expect(parseCsvRows('a,"b\nc')).toEqual([['a', 'b\nc']]);
  });
  it('handles empty cells, trailing commas and a missing final newline', () => {
    expect(parseCsvRows(',a,\r\nb,,')).toEqual([['', 'a', ''], ['b', '', '']]);
    expect(parseCsvRows('  \n,,\n')).toEqual([]);
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
    ['¥1,000.50', 1000.5],
    ['12.50 USD', 12.5],
    ['1,234.56-', -1234.56],
    ['+3', 3],
    ['.5', 0.5],
  ])('parses %s', (raw, n) => expect(parseAmount(raw)).toBe(n));
  it.each(['', '$', '()', '1.2.3', '12abc'])('rejects %j', (raw) => expect(parseAmount(raw)).toBeNull());
});

describe('decimal separators', () => {
  it.each([
    ['12,50', 12.5],
    ['1.234,56', 1234.56],
    ['-1.234.567,8', -1234567.8],
    ['1 234,56 €', 1234.56],
    ['(12,50)', -12.5],
    ['1.234', 1234],
  ])('reads %s with a decimal comma', (raw, n) => expect(parseAmount(raw, ',')).toBe(n));
  it.each(['1,234.56', '12.50', '1.23.4', '12,5,0'])('rejects %j with a decimal comma', (raw) => expect(parseAmount(raw, ',')).toBeNull());
  it.each(['12,50', '1.234,56', '1,23', '1,23,45', ',5'])('rejects %j with a decimal point', (raw) => expect(parseAmount(raw)).toBeNull());

  it('reads Indian lakh grouping with a decimal point', () => {
    expect(parseAmount('1,23,456.78')).toBe(123456.78);
    expect(parseAmount('-12,34,567')).toBe(-1234567);
    expect(readAmount('1,23,456.78')).toBe(123456.78);
    for (const raw of ['01,23,456', '1,2,345', '1,23,4567', '1.23.456,78']) expect(readAmount(raw)).toBeNull();
  });

  it('accepts spaces grouping thousands in threes but rejects inconsistent or mixed grouping', () => {
    expect(parseAmount('1 234,56', ',')).toBe(1234.56);
    expect(parseAmount('1 234 567,8', ',')).toBe(1234567.8);
    expect(parseAmount('-1 234,56 SEK', ',')).toBe(-1234.56);
    expect(parseAmount('SEK 12,50', ',')).toBe(12.5);
    expect(parseAmount('12.00 USD')).toBe(12);
    expect(parseAmount('- $ 5')).toBe(-5);
    for (const raw of ['12 34,56', '1 234.567,89', '1 2345', '1,234 567.00']) expect(readAmount(raw)).toBeNull();
  });

  it.each([
    ['−12.50', -12.5], ['–12.50', -12.5], ['‒12.50', -12.5], ['﹣12.50', -12.5], ['－12.50', -12.5], ['12.50−', -12.5],
    ['(12.50)', -12.5], ['1,234.56', 1234.56],
  ])('normalizes minus signs and reads %s', (raw, n) => expect(parseAmount(raw)).toBe(n));

  it('rounds to cents, halves away from zero', () => {
    expect(parseAmount('1.005')).toBe(1.01);
    expect(parseAmount('-1.005')).toBe(-1.01);
    expect(parseAmount('12.3449')).toBe(12.34);
    expect(parseAmount('0,125', ',')).toBe(0.13);
    expect(parseAmount('-0.001')).toBe(0);
  });

  it('reads a value without a known separator only when it has one meaning', () => {
    expect(readAmount('12,50')).toBe(12.5);
    expect(readAmount('1.234,56')).toBe(1234.56);
    expect(readAmount('1,234.56')).toBe(1234.56);
    expect(readAmount('−12.50')).toBe(-12.5);
    expect(readAmount('1234')).toBe(1234);
    expect(readAmount('1,234')).toBe('ambiguous');
    expect(readAmount('1.234')).toBe('ambiguous');
    expect(readAmount('1,234', '.')).toBe(1234);
    expect(readAmount('1,234', ',')).toBe(1.23);
    expect(readAmount('abc')).toBeNull();
  });

  it('detects the separator a value can only be read with, unless values disagree', () => {
    expect(detectDecimal(['1,234', '12,50'])).toBe(',');
    expect(detectDecimal(['1.234', '1.234.567'])).toBe(',');
    expect(detectDecimal(['1,234', '-6.25'])).toBe('.');
    expect(detectDecimal(['0,123'])).toBe(',');
    expect(detectDecimal(['12.3456'])).toBe('.');
    expect(detectDecimal(['1,234', '1.234', '12', ''])).toBeUndefined();
    expect(detectDecimal(['12,50', '12.50'])).toBeUndefined();
  });

  it('applies the detected separator in the fixed-column parser and skips ambiguous amounts', () => {
    const eu = parseTransactionsCsv('date,description,amount\n2026-01-02,Tea,"-3,50"\n2026-01-03,Rent,"-1.234"');
    expect(eu.transactions.map((t) => t.amount)).toEqual([-3.5, -1234]);
    const unclear = parseTransactionsCsv('date,description,amount\n2026-01-02,Tea,-3\n2026-01-03,Rent,"-1,234"');
    expect(unclear.transactions.map((t) => t.amount)).toEqual([-3]);
    expect(unclear.skipped).toBe(1);
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

describe('amount and date rejections', () => {
  it.each(['', '   ', 'USD', '--5', '-5-', '1e3', '12.3.4', 'N/A', '$'])('rejects %j', (raw) => expect(parseAmount(raw)).toBeNull());
  it.each(['2026-13-01', '02/29/2027', '00/10/2026', '10/32/2026', 'Foo 3, 2026', '2026-10'])('rejects date %j', (raw) =>
    expect(normalizeDate(raw)).toBeNull());
  it('accepts leap days', () => {
    expect(normalizeDate('02/29/2028')).toBe('2028-02-29');
    expect(normalizeDate('29 Feb 2028')).toBe('2028-02-29');
  });
});
