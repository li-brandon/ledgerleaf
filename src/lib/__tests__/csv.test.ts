import { describe, expect, it } from 'vitest';
import { detectDateOrder, detectDecimal, detectDelimiter, normalizeDate, parseAmount, parseCsvRows, parseTransactionsCsv, readAmount, readDate } from '../csv';

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
  it.each([
    [',', 'Date,Payee,Amount\n2026-10-01,"Smith, John; Tea\tshop","1,5"'],
    [';', 'Date;Payee;Amount\n2026-10-01;"Smith, John; Tea\tshop";1,5'],
    ['\t', 'Date\tPayee\tAmount\n2026-10-01\t"Smith, John; Tea\tshop"\t1,5'],
  ] as const)('splits on %j only, outside quotes', (delimiter, text) => {
    expect(parseCsvRows(text, delimiter)).toEqual([
      ['Date', 'Payee', 'Amount'],
      ['2026-10-01', 'Smith, John; Tea\tshop', '1,5'],
    ]);
  });
});

describe('detectDelimiter', () => {
  it.each([
    [',', 'Date,Payee,Amount\n2026-10-01,Tea,-3.50\n2026-10-02,Cake,-4'],
    [';', 'Datum;Text;Belopp\n01.10.2026;Kaffe;-12,50\n02.10.2026;Lön;25.000,00'],
    ['\t', 'Date\tPayee\tAmount\n2026-10-01\tTea, black\t-3,50'],
  ] as const)('detects %j from the header and rows', (delimiter, text) => {
    expect(detectDelimiter(text)).toBe(delimiter);
  });

  it('ignores the other delimiters inside quoted cells', () => {
    expect(detectDelimiter('Date,Payee,Amount\n2026-10-01,"Smith; John",-3\n2026-10-02,"a;b;c;d",-4')).toBe(',');
    expect(detectDelimiter('Date;Payee;Amount\n2026-10-01;"Smith, John";"-3,50"')).toBe(';');
    expect(detectDelimiter('Date\tPayee\n2026-10-01\t"x;y,z"')).toBe('\t');
  });

  it('prefers the delimiter giving more columns, then comma before semicolon and tab', () => {
    // Every row has one comma, but more semicolons.
    expect(detectDelimiter('a;b,c;d\n1;2,5;3')).toBe(';');
    expect(detectDelimiter('a,b;c\n1,2;3')).toBe(',');
  });

  it('defaults to comma when no delimiter splits every row evenly', () => {
    expect(detectDelimiter('Amount\n12\n13')).toBe(',');
    expect(detectDelimiter('a;b\n1;2;3')).toBe(',');
    expect(detectDelimiter('')).toBe(',');
  });

  it('only samples the first lines, and leaves out a row the sample cuts off', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `2026-10-01;Row ${i};-${i}`);
    expect(detectDelimiter(['Date;Payee;Amount', ...rows, 'odd'].join('\n'))).toBe(';');
    // Row 19 holds a line break in quotes, so the sample ends inside it.
    rows[18] = '2026-10-01;"two\nlines";-1';
    expect(detectDelimiter(['Date;Payee;Amount', ...rows].join('\n'))).toBe(';');
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
    ['12.50 usd', 12.5],
    ['Sek 12', 12],
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
    ['12,50 eur', 12.5],
    [' -1.234,56 Sek ', -1234.56],
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

describe('date orders', () => {
  it.each([
    ['12/31/2026', 'MDY', '2026-12-31'],
    ['12.31.2026', 'MDY', '2026-12-31'],
    ['12-31-26', 'MDY', '2026-12-31'],
    ['31/12/2026', 'DMY', '2026-12-31'],
    ['31.12.2026', 'DMY', '2026-12-31'],
    ['1-2-99', 'DMY', '1999-02-01'],
    ['2026/12/31', 'YMD', '2026-12-31'],
    ['2026.12.31', 'YMD', '2026-12-31'],
    ['2026-12-31', 'YMD', '2026-12-31'],
    ['25-10-01', 'YMD', '2025-10-01'],
    ['26/12/31', 'YMD', '2026-12-31'],
  ] as const)('reads %s as %s', (raw, order, iso) => expect(normalizeDate(raw, order)).toBe(iso));

  it('reads year-first and month-name dates in every order, and nothing else outside its order', () => {
    for (const order of ['MDY', 'DMY', 'YMD'] as const) {
      expect(normalizeDate('2026-12-31T08:00:00Z', order)).toBe('2026-12-31');
      expect(normalizeDate('31 Dec 2026', order)).toBe('2026-12-31');
    }
    expect(normalizeDate('31.12.2026', 'MDY')).toBeNull();
    expect(normalizeDate('12/31/2026', 'DMY')).toBeNull();
    expect(normalizeDate('12/31/2026', 'YMD')).toBeNull();
    expect(normalizeDate('31/02/2026', 'DMY')).toBeNull();
  });

  it('reads a date without an order only when every order agrees on it', () => {
    expect(readDate('01/02/2026')).toBe('ambiguous');
    expect(readDate('1.2.26')).toBe('ambiguous');
    expect(readDate('05/05/2026')).toBe('2026-05-05');
    expect(readDate('05/05/05')).toBe('2005-05-05');
    expect(readDate('2026-12-31')).toBe('2026-12-31');
    expect(readDate('3 Oct 2026')).toBe('2026-10-03');
    expect(readDate('31/02/2026')).toBeNull();
    expect(readDate('01/02/2026', 'DMY')).toBe('2026-02-01');
    // A date in only some orders waits for one: the rows may show another.
    expect(readDate('13/01/2026')).toBe('ambiguous');
    expect(readDate('01/13/2026')).toBe('ambiguous');
    // Two-digit years may come first.
    expect(readDate('25-10-01')).toBe('ambiguous');
    expect(readDate('26/12/31')).toBe('ambiguous');
    expect(readDate('25-10-01', 'YMD')).toBe('2025-10-01');
  });

  it('lets an order detected from the rows settle month against day first, but not a year first', () => {
    expect(readDate('01/02/2026', 'DMY', true)).toBe('2026-02-01');
    expect(readDate('2026-12-31', 'DMY', true)).toBe('2026-12-31');
    expect(readDate('12-31-26', 'MDY', true)).toBe('2026-12-31');
    for (const order of ['MDY', 'DMY'] as const) {
      expect(readDate('25-10-01', order, true)).toBe('ambiguous');
      expect(readDate('26/12/31', order, true)).toBe('ambiguous');
    }
    // Chosen, the order settles it.
    expect(readDate('25-10-01', 'DMY')).toBe('2001-10-25');
  });

  it('detects the one order every telling date agrees with', () => {
    expect(detectDateOrder(['01/02/2026', '13/01/2026'])).toBe('DMY');
    expect(detectDateOrder(['31.12.2026'])).toBe('DMY');
    expect(detectDateOrder(['01/13/2026', '05/05/2026', '3 Oct 2026', ''])).toBe('MDY');
    // No evidence: ISO dates (they read the same in every order), valid in every order, ambiguous between month and day first, or not a date.
    expect(detectDateOrder(['2026-01-02', '2026-01-13'])).toBeUndefined();
    expect(detectDateOrder(['01/02/2026', '05/05/2026', '3 Oct 2026', '31/02/2026', ''])).toBeUndefined();
    // ISO dates don't contradict a day-first file.
    expect(detectDateOrder(['13/01/2026', '2026-01-13'])).toBe('DMY');
    // Conflicting evidence.
    expect(detectDateOrder(['13/01/2026', '01/13/2026'])).toBeUndefined();
  });

  it('takes no evidence from two-digit years, which may come first', () => {
    expect(detectDateOrder(['25-10-01', '25-10-15'])).toBeUndefined();
    expect(detectDateOrder(['1-13-26', '13-1-26'])).toBeUndefined();
    expect(detectDateOrder(['25-10-01', '26/12/31', '01/13/2026'])).toBe('MDY');
  });

  it('detects the order in the fixed-column parser and skips ambiguous dates', () => {
    const eu = parseTransactionsCsv('date,description,amount\n31.12.2026,Tea,-3\n01.02.2026,Rent,-1');
    expect(eu.transactions.map((t) => t.date)).toEqual(['2026-12-31', '2026-02-01']);
    const unclear = parseTransactionsCsv('date,description,amount\n05/05/2026,Tea,-3\n01/02/2026,Rent,-1');
    expect(unclear.transactions.map((t) => t.date)).toEqual(['2026-05-05']);
    expect(unclear.skipped).toBe(1);
  });

  it('skips dates in the fixed-column parser that only read in an order the rows contradict, or year first', () => {
    const conflict = parseTransactionsCsv('date,description,amount\n13/01/2026,Tea,-3\n01/13/2026,Rent,-1\n05/05/2026,Cake,-2');
    expect(conflict.transactions.map((t) => t.date)).toEqual(['2026-05-05']);
    const yearFirst = parseTransactionsCsv('date,description,amount\n13/01/2026,Tea,-3\n25-10-01,Rent,-1\n26/12/31,Cake,-2');
    expect(yearFirst.transactions.map((t) => t.date)).toEqual(['2026-01-13']);
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

  it.each([';', '\t'])('detects a %j delimiter', (d) => {
    const r = parseTransactionsCsv(['date', 'description', 'amount', 'account'].join(d) + '\n' + ['31.12.2026', '"Tea;\tCake"', '-12,50 eur', 'Card'].join(d));
    expect(r.transactions).toEqual([expect.objectContaining({ date: '2026-12-31', description: 'Tea;\tCake', amount: -12.5, accountId: 'csv-card' })]);
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
