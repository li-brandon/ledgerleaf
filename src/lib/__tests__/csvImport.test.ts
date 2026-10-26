import { describe, expect, it } from 'vitest';
import { parseCsvRows } from '../csv';
import {
  applyMapping, currencyDecimal, detectMapping, detectOrder, detectSeparator, errorRowsCsv, mappingFor, mappingProblem, readCsvTable,
} from '../csvMapping';
import { emptyLedger } from '../migrate';
import { CsvImportProvider, applySync, fetchSync, type CsvImportOptions } from '../sync';
import type { Account, DateOrder, LedgerState } from '../types';
import amex from './fixtures/amex.csv?raw';
import chase from './fixtures/chase.csv?raw';
import generic from './fixtures/generic.csv?raw';

const now = new Date(2026, 9, 20);
const card: Account = { id: 'csv-sample-card', name: 'Sample Card', type: 'credit' };

/** What the import screen does: build a mapped provider and run it through the sync pipeline. */
async function importCsv(state: LedgerState, text: string, options: Partial<CsvImportOptions> = {}) {
  const mapping = options.mapping ?? detectMapping(readCsvTable(text).headers);
  const accountId = options.accountId ?? card.id;
  const newAccount = 'newAccount' in options ? options.newAccount : state.accounts.some((a) => a.id === accountId) ? undefined : card;
  const p = new CsvImportProvider(text, { mapping, accountId, newAccount });
  const outcome = applySync(state, p.id, await fetchSync(p, state), now);
  return { ...outcome, provider: p, duplicates: outcome.received - outcome.added };
}

describe('readCsvTable', () => {
  it('splits off the header row and makes names unique', () => {
    const t = readCsvTable('Date,Amount,Amount\n2026-01-01,1,2');
    expect(t).toEqual({ headers: ['Date', 'Amount', 'Amount (2)'], rows: [['2026-01-01', '1', '2']], hasHeader: true });
  });

  it.each(['31.12.2026', '13/01/2026', '01/02/2026'])('reads a first row dated %s as data', (date) => {
    expect(readCsvTable(`${date},Tea,-3`)).toMatchObject({ headers: ['Column 1', 'Column 2', 'Column 3'], hasHeader: false });
  });

  it.each([
    [',', 'Date,Payee,Amount\n2026-10-01,"Smith; John",-3.50\n2026-10-02,"Pay, October",2000'],
    [';', 'Date;Payee;Amount\n2026-10-01;"Smith; John";-3,50\n2026-10-02;"Pay, October";2000'],
    ['\t', 'Date\tPayee\tAmount\n2026-10-01\t"Smith; John"\t-3,50\n2026-10-02\t"Pay, October"\t2000'],
  ] as const)('detects a %j delimiter and keeps it inside quoted cells', (delimiter, text) => {
    const t = readCsvTable(text);
    expect(t.headers).toEqual(['Date', 'Payee', 'Amount']);
    expect(t.rows.map((r) => r[1])).toEqual(['Smith; John', 'Pay, October']);
    expect(readCsvTable(text, delimiter)).toEqual(t);
    expect(applyMapping(t, detectMapping(t.headers), 'acct').transactions.map((x) => [x.description, x.amount]))
      .toEqual([['Smith; John', -3.5], ['Pay, October', 2000]]);
  });

  it('reads with a given delimiter instead of the detected one', () => {
    const text = 'Date;Payee,Amount\n2026-10-01;Tea,-3';
    expect(readCsvTable(text).headers).toEqual(['Date;Payee', 'Amount']);
    expect(readCsvTable(text, ';').headers).toEqual(['Date', 'Payee,Amount']);
  });

  it('names columns when the file has no header row', () => {
    const t = readCsvTable('2026-01-01,Tea,-3\n2026-01-02,Cake,-4,extra');
    expect(t.hasHeader).toBe(false);
    expect(t.headers).toEqual(['Column 1', 'Column 2', 'Column 3', 'Column 4']);
    expect(t.rows).toHaveLength(2);
  });
});

describe('detectMapping', () => {
  it('maps a Chase-style export', () => {
    expect(detectMapping(readCsvTable(chase).headers)).toEqual({
      date: 'Transaction Date', description: 'Description', amount: 'Amount', category: 'Category',
    });
  });

  it('maps an Amex-style export and flips its positive charges', () => {
    expect(detectMapping(readCsvTable(amex).headers)).toEqual({
      date: 'Date', description: 'Description', amount: 'Amount', category: 'Category', negate: true,
    });
  });

  it('maps separate withdrawal and deposit columns', () => {
    expect(detectMapping(readCsvTable(generic).headers)).toEqual({
      date: 'Booking Date', description: 'Payee', debit: 'Withdrawals', credit: 'Deposits',
    });
  });

  it('falls back to loose matches and leaves unknown fields empty', () => {
    expect(detectMapping(['Date of purchase', 'Desc.', 'Total amount (USD)'])).toEqual({
      date: 'Date of purchase', description: 'Desc.', amount: 'Total amount (USD)',
    });
    const m = detectMapping(['foo', 'bar']);
    expect(m).toEqual({ date: '', description: '' });
    expect(mappingProblem(m, ['foo', 'bar'])).toMatch(/date/);
  });
});

describe('mappingProblem / mappingFor', () => {
  const headers = ['When', 'What', 'Out', 'In'];
  it('requires date, description and an amount source that exist in the file', () => {
    expect(mappingProblem({ date: 'When', description: 'What', debit: 'Out' }, headers)).toBeUndefined();
    expect(mappingProblem({ date: 'When', description: 'What' }, headers)).toMatch(/debit or credit/);
    expect(mappingProblem({ date: 'When', description: 'What', amount: 'Sum' }, headers)).toMatch(/amount/);
    expect(mappingProblem({ date: 'When', description: 'What', debit: 'Out', category: 'Cat' }, headers)).toMatch(/"Cat"/);
  });

  it('reuses a saved mapping only when it fits the file', () => {
    const saved = { date: 'When', description: 'What', debit: 'Out', credit: 'In' };
    expect(mappingFor(headers, saved)).toBe(saved);
    expect(mappingFor(['Date', 'Description', 'Amount'], saved)).toEqual({ date: 'Date', description: 'Description', amount: 'Amount' });
  });
});

describe('applyMapping', () => {
  it('reads the Chase fixture and reports bad rows', () => {
    const table = readCsvTable(chase);
    const { transactions, errors } = applyMapping(table, detectMapping(table.headers), 'acct');
    expect(transactions).toHaveLength(11);
    expect(transactions[0]).toMatchObject({ date: '2026-10-14', description: 'CORNER BAKERY #12', amount: -6.25, category: 'Food & Drink', accountId: 'acct' });
    expect(transactions[1].description).toBe('FERNWAY MARKET, INC');
    expect(transactions.find((t) => t.description === 'NORTHWIND OUTFITTERS')?.amount).toBe(-1204.5);
    expect(transactions.find((t) => t.description.startsWith('AUTOPAY'))).toMatchObject({ amount: 500, category: 'Other' });
    expect(errors.map(({ row, reason }) => ({ row, reason }))).toEqual([
      { row: 13, reason: 'Unreadable date "13/45/2026"' },
      { row: 14, reason: 'Unreadable amount "n/a"' },
    ]);
  });

  it('flips Amex amounts so charges are spending and refunds are income', () => {
    const table = readCsvTable(amex);
    // Two-digit years ("10/9/26") don't show the date order, so Amex files need one chosen.
    const { transactions, errors } = applyMapping(table, { ...detectMapping(table.headers), dateOrder: 'MDY' }, 'acct');
    expect(transactions.map((t) => [t.date, t.description, t.amount])).toEqual([
      ['2026-10-16', 'NORI HOUSE', -48.6],
      ['2026-10-15', 'CINEMA LUX', -24],
      ['2026-10-13', 'ONLINE PAYMENT - THANK YOU', 350],
      ['2026-10-11', 'ARCADIA GAMES', -1019.99],
      ['2026-10-09', 'SLICE & CO', 12],
    ]);
    expect(errors).toEqual([{ row: 7, cells: expect.any(Array), reason: 'Missing description' }]);
  });

  it('combines debit and credit columns across date formats', () => {
    const table = readCsvTable(generic);
    // Nothing in the file shows whether "10/6/26" is 6 October or 10 June, so those rows wait for a date order.
    expect(applyMapping(table, detectMapping(table.headers), 'acct').errors.filter((e) => e.kind === 'ambiguous-date').map((e) => e.row))
      .toEqual([6, 7]);
    const { transactions, errors } = applyMapping(table, { ...detectMapping(table.headers), dateOrder: 'MDY' }, 'acct');
    expect(transactions.map((t) => [t.date, t.description, t.amount])).toEqual([
      ['2026-10-01', 'Brightwater Payroll', 2900],
      ['2026-10-02', 'Maple Street Lofts', -1650],
      ['2026-10-03', 'Green Basket Market', -54.2],
      ['2026-10-05', 'City Power & Water', -112.4],
      ['2026-10-06', 'Harvest Co-op', -32.15],
      ['2026-10-07', 'Transfer from Rainy Day Savings', 250],
      ['2026-10-07', 'Juniper "Café"', -8.5],
    ]);
    expect(errors.map((e) => e.reason)).toEqual(['Missing amount', 'Unreadable date "31 Sep 2026"', 'Unreadable debit "abc"']);
  });

  it('gives identical rows distinct but stable ids', () => {
    const table = readCsvTable(chase);
    const ids = () => applyMapping(table, detectMapping(table.headers), 'acct').transactions.map((t) => t.id);
    expect(ids()).toEqual(ids());
    expect(new Set(ids()).size).toBe(11);
  });

  it('detects a decimal comma from the rows and reads every amount with it', () => {
    const table = readCsvTable('Date,Description,Amount\n2026-10-01,Hyra,"-1.234"\n2026-10-02,Lön,"25.000,00"\n2026-10-03,Kaffe,"−12,5"');
    const m = detectMapping(table.headers);
    expect(detectSeparator(table, m)).toBe(',');
    expect(applyMapping(table, m, 'acct').transactions.map((t) => t.amount)).toEqual([-1234, 25000, -12.5]);
  });

  it('turns amounts that are ambiguous without a separator into error rows, until one is chosen', () => {
    const table = readCsvTable('Date,Description,Amount\n2026-10-01,Rent,"-1,234"\n2026-10-02,Tea,-3');
    const m = detectMapping(table.headers);
    expect(detectSeparator(table, m)).toBeUndefined();
    const { transactions, errors } = applyMapping(table, m, 'acct');
    expect(transactions.map((t) => t.amount)).toEqual([-3]);
    expect(errors).toEqual([{
      row: 2, cells: ['2026-10-01', 'Rent', '-1,234'], reason: 'Ambiguous amount "-1,234": choose the decimal separator', kind: 'ambiguous',
    }]);
    expect(applyMapping(table, { ...m, decimal: '.' }, 'acct').transactions.map((t) => t.amount)).toEqual([-1234, -3]);
    expect(applyMapping(table, { ...m, decimal: ',' }, 'acct').transactions.map((t) => t.amount)).toEqual([-1.23, -3]);
  });

  it('only lets a saved separator settle ambiguous amounts when the rows show it too', async () => {
    const mapping = { date: 'Date', description: 'Description', amount: 'Amount', decimal: ',' as const };
    const csv = 'Date,Description,Amount\n2026-10-01,Pay,"1,234"\n2026-10-02,Rent,"-2,500"\n2026-10-03,Tea,-3';
    const table = readCsvTable(csv);
    const saved = applyMapping(table, mapping, 'acct', { savedDecimal: true });
    expect(saved.transactions.map((t) => t.amount)).toEqual([-3]);
    expect(saved.errors.map((e) => [e.row, e.kind])).toEqual([[2, 'ambiguous'], [3, 'ambiguous']]);
    // The provider reads the file exactly as the preview does.
    const p = new CsvImportProvider(csv, { mapping, accountId: 'acct', savedDecimal: true });
    expect(await p.fetchTransactions()).toEqual(saved.transactions);
    expect(p.errors).toEqual(saved.errors);

    // Chosen for this import, the same separator reads them.
    expect(applyMapping(table, mapping, 'acct').transactions.map((t) => t.amount)).toEqual([1.23, -2.5, -3]);
    // Rows that show the saved separator back it up; values that read the same either way always import.
    const shown = readCsvTable(`${csv}\n2026-10-04,Cake,"12,50"`);
    expect(applyMapping(shown, mapping, 'acct', { savedDecimal: true }).transactions.map((t) => t.amount)).toEqual([1.23, -2.5, -3, 12.5]);
    // Rows that show the other separator do not.
    const other = readCsvTable(`${csv}\n2026-10-04,Cake,"1,234.50"`);
    expect(applyMapping(other, mapping, 'acct', { savedDecimal: true }).errors.map((e) => e.kind ?? e.reason))
      .toEqual(['ambiguous', 'ambiguous', 'Unreadable amount "1,234.50"']);
  });

  it('lets an explicit separator win over the one the rows show', () => {
    const table = readCsvTable('Date,Description,Amount\n2026-10-01,Tea,"12,50"\n2026-10-02,Cake,"1,234"');
    expect(applyMapping(table, detectMapping(table.headers), 'acct').transactions.map((t) => t.amount)).toEqual([12.5, 1.23]);
    const { transactions, errors } = applyMapping(table, { ...detectMapping(table.headers), decimal: '.' }, 'acct');
    expect(transactions.map((t) => t.amount)).toEqual([1234]);
    expect(errors.map((e) => e.reason)).toEqual(['Unreadable amount "12,50"']);
  });

  it('detects across debit and credit columns and rounds their difference to cents', () => {
    const table = readCsvTable('Date,Payee,Debit,Credit\n2026-10-01,Shop,"0,1","0,3"\n2026-10-02,Pay,,"1.500"\n2026-10-03,Fee,"0,125",');
    const { transactions } = applyMapping(table, detectMapping(table.headers), 'acct');
    expect(transactions.map((t) => t.amount)).toEqual([0.2, 1500, -0.13]);
  });

  it('keeps ambiguous amounts as error rows whatever the display currency', async () => {
    const mapping = { date: 'Date', description: 'Description', amount: 'Amount' };
    for (const currency of ['USD', 'EUR']) {
      // Held in a variable, as an older caller would pass it: the currency must not settle the separator.
      const options = { mapping, accountId: 'acct', currency };
      for (const csv of ['Date,Description,Amount\n2026-10-01,Rent,"-1,500"', 'Date,Description,Amount\n2026-10-01,Rent,-1.234']) {
        const p = new CsvImportProvider(csv, options);
        expect(await p.fetchTransactions()).toEqual([]);
        expect(p.errors.map((e) => e.reason)).toEqual([expect.stringMatching(/^Ambiguous amount .*: choose the decimal separator$/)]);
      }
    }
    expect(currencyDecimal('USD')).toBe('.');
    expect(currencyDecimal('EUR')).toBe(',');
    expect(currencyDecimal('CHF')).toBeUndefined();
    expect(currencyDecimal(' eur ')).toBe(',');
    expect(currencyDecimal('Usd')).toBe('.');
  });

  it('reads the file with the mapping\'s delimiter, else the detected one, in the provider as in the preview', async () => {
    const csv = 'Date;Payee;Amount\n2026-10-01;"Smith; John";-3,50\n2026-10-02;Pay;"1.234,00"';
    for (const delimiter of [undefined, ';'] as const) {
      const table = readCsvTable(csv, delimiter);
      const mapping = { ...detectMapping(table.headers), delimiter };
      const preview = applyMapping(table, mapping, 'acct');
      expect(preview.transactions.map((t) => t.amount)).toEqual([-3.5, 1234]);
      const p = new CsvImportProvider(csv, { mapping, accountId: 'acct' });
      expect(await p.fetchTransactions()).toEqual(preview.transactions);
      expect(p.table).toEqual(table);
    }
    // A mapping saved for the semicolon file does not fit it read with commas.
    const p = new CsvImportProvider(csv, { mapping: { date: 'Date', description: 'Payee', amount: 'Amount', delimiter: ',' }, accountId: 'acct' });
    expect(() => p.errors).toThrow('Choose the column that holds the date.');
  });

  it('detects day-first dotted dates from the rows and reads every date with that order', () => {
    const table = readCsvTable('Date,Description,Amount\n31.12.2026,Hyra,-1\n01.02.2026,Kaffe,-2');
    const m = detectMapping(table.headers);
    expect(detectOrder(table, m)).toBe('DMY');
    expect(applyMapping(table, m, 'acct').transactions.map((t) => t.date)).toEqual(['2026-12-31', '2026-02-01']);
  });

  it('turns dates that are ambiguous without an order into typed error rows, until one is chosen', () => {
    const table = readCsvTable('Date,Description,Amount\n01/02/2026,Rent,-1000\n05/05/2026,Tea,-3\n2026-05-06,Cake,-4');
    const m = detectMapping(table.headers);
    expect(detectOrder(table, m)).toBeUndefined();
    const { transactions, errors } = applyMapping(table, m, 'acct');
    // Dates that read the same in every order import without one.
    expect(transactions.map((t) => t.date)).toEqual(['2026-05-05', '2026-05-06']);
    expect(errors).toEqual([{
      row: 2, cells: ['01/02/2026', 'Rent', '-1000'], reason: 'Ambiguous date "01/02/2026": choose the date order', kind: 'ambiguous-date',
    }]);
    expect(applyMapping(table, { ...m, dateOrder: 'MDY' }, 'acct').transactions.map((t) => t.date)).toEqual(['2026-01-02', '2026-05-05', '2026-05-06']);
    expect(applyMapping(table, { ...m, dateOrder: 'DMY' }, 'acct').transactions.map((t) => t.date)).toEqual(['2026-02-01', '2026-05-05', '2026-05-06']);
  });

  it('rejects dates that are invalid in the chosen or detected order', () => {
    const table = readCsvTable('Date,Description,Amount\n31/02/2026,Rent,-1\n13/01/2026,Tea,-3');
    const m = detectMapping(table.headers);
    expect(applyMapping(table, m, 'acct').errors.map((e) => e.reason)).toEqual(['Unreadable date "31/02/2026"']);
    expect(applyMapping(table, { ...m, dateOrder: 'MDY' }, 'acct').errors.map((e) => e.reason))
      .toEqual(['Unreadable date "31/02/2026"', 'Unreadable date "13/01/2026"']);
  });

  it('only lets a saved date order settle ambiguous dates when the rows show it too', async () => {
    const mapping = { date: 'Date', description: 'Description', amount: 'Amount', dateOrder: 'DMY' as const };
    const csv = 'Date,Description,Amount\n01/02/2026,Pay,1\n03/04/2026,Rent,-2\n2026-05-06,Tea,-3';
    const table = readCsvTable(csv);
    const saved = applyMapping(table, mapping, 'acct', { savedDateOrder: true });
    expect(saved.transactions.map((t) => t.date)).toEqual(['2026-05-06']);
    expect(saved.errors.map((e) => [e.row, e.kind])).toEqual([[2, 'ambiguous-date'], [3, 'ambiguous-date']]);
    // The provider reads the file exactly as the preview does.
    const p = new CsvImportProvider(csv, { mapping, accountId: 'acct', savedDateOrder: true });
    expect(await p.fetchTransactions()).toEqual(saved.transactions);
    expect(p.errors).toEqual(saved.errors);

    // Chosen for this import, the same order reads them.
    expect(applyMapping(table, mapping, 'acct').transactions.map((t) => t.date)).toEqual(['2026-02-01', '2026-04-03', '2026-05-06']);
    // Rows that show the saved order back it up; rows that show another do not.
    const shown = readCsvTable('Date,Description,Amount\n01/02/2026,Pay,1\n13/04/2026,Rent,-2');
    expect(applyMapping(shown, mapping, 'acct', { savedDateOrder: true }).transactions.map((t) => t.date)).toEqual(['2026-02-01', '2026-04-13']);
    const other = readCsvTable('Date,Description,Amount\n01/02/2026,Pay,1\n04/13/2026,Rent,-2');
    expect(applyMapping(other, mapping, 'acct', { savedDateOrder: true }).errors.map((e) => e.kind ?? e.reason))
      .toEqual(['ambiguous-date', 'Unreadable date "04/13/2026"']);
    // An unconfirmed saved order still reads dates that are a real date in only one order.
    const us = readCsvTable('Date,Description,Amount\n10/13/26,Tea,-3\n10/9/26,Cake,-4');
    const usSaved = applyMapping(us, { ...mapping, dateOrder: 'MDY' }, 'acct', { savedDateOrder: true });
    expect(usSaved.transactions.map((t) => t.date)).toEqual(['2026-10-13']);
    expect(usSaved.errors.map((e) => [e.row, e.kind])).toEqual([[3, 'ambiguous-date']]);
  });

  it('holds back dates that only read in an order the other rows contradict, until one is chosen', () => {
    const table = readCsvTable('Date,Description,Amount\n13/01/2026,Tea,-3\n01/13/2026,Rent,-1\n05/05/2026,Cake,-2\n2026-05-06,Pie,-4\n3 Oct 2026,Jam,-5');
    const m = detectMapping(table.headers);
    expect(detectOrder(table, m)).toBeUndefined();
    const { transactions, errors } = applyMapping(table, m, 'acct');
    expect(transactions.map((t) => t.date)).toEqual(['2026-05-05', '2026-05-06', '2026-10-03']);
    expect(errors.map((e) => [e.row, e.kind, e.reason])).toEqual([
      [2, 'ambiguous-date', 'Ambiguous date "13/01/2026": choose the date order'],
      [3, 'ambiguous-date', 'Ambiguous date "01/13/2026": choose the date order'],
    ]);
    const dmy = applyMapping(table, { ...m, dateOrder: 'DMY' }, 'acct');
    expect(dmy.transactions.map((t) => t.date)).toEqual(['2026-01-13', '2026-05-05', '2026-05-06', '2026-10-03']);
    expect(dmy.errors.map((e) => e.reason)).toEqual(['Unreadable date "01/13/2026"']);
  });

  it('never reads two-digit-year dates that are also dates year first without a chosen order', () => {
    const rows = 'Date,Description,Amount\n25-10-01,Rent,-1000\n26/12/31,Tea,-3\n05/05/05,Cake,-4';
    for (const telling of ['', '\n13/01/2026,Pay,1', '\n01/13/2026,Pay,1']) {
      const table = readCsvTable(rows + telling);
      const m = detectMapping(table.headers);
      const { transactions, errors } = applyMapping(table, m, 'acct');
      expect(errors.map((e) => [e.row, e.kind])).toEqual([[2, 'ambiguous-date'], [3, 'ambiguous-date']]);
      expect(transactions.map((t) => t.date)).toEqual(['2005-05-05', ...(telling ? ['2026-01-13'] : [])]);
    }
    const table = readCsvTable(rows);
    const ymd = applyMapping(table, { ...detectMapping(table.headers), dateOrder: 'YMD' }, 'acct');
    expect(ymd.transactions.map((t) => t.date)).toEqual(['2025-10-01', '2026-12-31', '2005-05-05']);
  });

  it('refuses a mapping that does not fit the file', () => {
    expect(() => applyMapping(readCsvTable(chase), { date: 'Nope', description: 'Description', amount: 'Amount' }, 'a')).toThrow(/date/);
  });
});

describe('errorRowsCsv', () => {
  it('round-trips the failed rows with their reasons', () => {
    const table = readCsvTable(amex);
    const { errors } = applyMapping(table, { ...detectMapping(table.headers), dateOrder: 'MDY' }, 'acct');
    const rows = parseCsvRows(errorRowsCsv(table, errors));
    expect(rows[0]).toEqual([...table.headers, 'Error']);
    expect(rows).toHaveLength(2);
    expect(rows[1].slice(0, -1)).toEqual(table.rows[5]);
    expect(rows[1].at(-1)).toBe('Row 7: Missing description');
  });

  it('quotes commas, quotes and newlines', () => {
    const table = { headers: ['A', 'B'], rows: [], hasHeader: true };
    const text = errorRowsCsv(table, [{ row: 2, cells: ['x, "y"', 'two\nlines'], reason: 'bad' }]);
    expect(text).toBe('A,B,Error\r\n"x, ""y""","two\nlines",Row 2: bad\r\n');
  });

  it('defuses formulas in every cell but leaves plain negative numbers', () => {
    const table = { headers: ['=Head', 'B', 'C'], rows: [], hasHeader: true };
    const cells = ['=HYPERLINK("http://evil.example","x")', '@SUM(A1:A9)', '-12.50'];
    const text = errorRowsCsv(table, [{ row: 2, cells, reason: 'bad' }]);
    expect(text).toBe(`'=Head,B,C,Error\r\n"'=HYPERLINK(""http://evil.example"",""x"")",'@SUM(A1:A9),-12.50,Row 2: bad\r\n`);
  });
});

describe('importing through the sync pipeline', () => {
  // The generic fixture's two "10/6/26"-style dates are ambiguous without a date order; the Amex one's are all two-digit-year dates.
  it.each([['Chase', chase, 11, 2], ['Amex', amex, 5, 1, 'MDY'], ['generic', generic, 5, 5]] as const)(
    'imports the %s fixture into a new account, and adds 0 when re-imported',
    async (_, text, rows, bad, dateOrder?: DateOrder) => {
      const mapping = { ...detectMapping(readCsvTable(text).headers), dateOrder };
      const first = await importCsv(emptyLedger('2026-10'), text, { mapping });
      expect(first).toMatchObject({ added: rows, duplicates: 0 });
      expect(first.provider.skipped).toBe(bad);
      expect(first.state.accounts).toEqual([expect.objectContaining({ ...card, currency: 'USD' })]);
      expect(first.state.transactions.every((t) => t.source === 'csv' && t.accountId === card.id)).toBe(true);
      expect(first.state.syncs?.csv).toEqual({ lastSync: now.toISOString() });

      const again = await importCsv(first.state, text, { mapping });
      expect(again).toMatchObject({ added: 0, updated: 0, duplicates: rows });
      expect(again.state.transactions).toHaveLength(rows);
    },
  );

  it('imports into an existing account without changing it', async () => {
    const base = { ...emptyLedger('2026-10'), accounts: [{ id: 'mine', name: 'Everyday', type: 'checking', currency: 'USD', hidden: false } as Account] };
    const r = await importCsv(base, generic, { accountId: 'mine', newAccount: undefined });
    expect(r.added).toBe(5);
    expect(r.state.accounts).toEqual(base.accounts);
    expect(r.state.transactions.every((t) => t.accountId === 'mine')).toBe(true);
  });

  it('keeps the same file in two accounts apart', async () => {
    const a = await importCsv(emptyLedger('2026-10'), chase);
    const other: Account = { id: 'csv-other', name: 'Other', type: 'credit' };
    const b = await importCsv(a.state, chase, { accountId: other.id, newAccount: other });
    expect(b.added).toBe(11);
  });

  it('skips only the overlap when a later export repeats earlier rows', async () => {
    const lines = chase.trim().split(/\r?\n/);
    const older = [lines[0], ...lines.slice(6, 12)].join('\n');
    const first = await importCsv(emptyLedger('2026-10'), older);
    const full = await importCsv(first.state, chase);
    expect(first.added).toBe(6);
    expect(full).toMatchObject({ added: 5, duplicates: 6 });
  });

  it('rejects the import when the target account does not exist', async () => {
    await expect(importCsv(emptyLedger('2026-10'), chase, { accountId: 'ghost', newAccount: undefined })).rejects.toThrow(/unknown account/);
  });
});
