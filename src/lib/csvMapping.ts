import { contentIds, detectDecimal, normalizeDate, parseCsvRows, readAmount, toCsv } from './csv';
import type { CsvMapping, DecimalSeparator, LedgerState, Transaction } from './types';

export type { CsvMapping, DecimalSeparator };

/** A CSV file split into a header row and data rows. */
export interface CsvTable {
  /** Column names, unique within the table. Generated ("Column 1", …) when the file has no header row. */
  headers: string[];
  rows: string[][];
  /** Whether the first line of the file was a header row. */
  hasHeader: boolean;
}

/** A row that could not be imported. */
export interface RowError {
  /** 1-based row number in the file, counting the header row but not blank lines. */
  row: number;
  cells: string[];
  reason: string;
  /** Set when the amount reads differently with each decimal separator and none is settled. */
  kind?: 'ambiguous';
}

export interface MappedRows {
  transactions: Transaction[];
  errors: RowError[];
}

/** Mappable fields, in the order the UI lists them. */
export const MAPPING_FIELDS = ['date', 'description', 'amount', 'debit', 'credit', 'category'] as const;
export type MappingField = (typeof MAPPING_FIELDS)[number];

export const FIELD_LABEL: Record<MappingField, string> = {
  date: 'Date', description: 'Description', amount: 'Amount', debit: 'Debit (money out)',
  credit: 'Credit (money in)', category: 'Category',
};

/**
 * Read CSV text into a table. The first row is the header unless it contains a date,
 * in which case the file has no header and columns are named "Column 1", "Column 2", ….
 */
export function readCsvTable(text: string): CsvTable {
  const rows = parseCsvRows(text);
  const width = Math.max(0, ...rows.map((r) => r.length));
  const hasHeader = rows.length > 0 && !rows[0].some((c) => normalizeDate(c) !== null);
  const names = hasHeader ? rows.shift()! : [];
  const headers: string[] = [];
  for (let i = 0; i < width; i++) {
    const base = names[i]?.trim() || `Column ${i + 1}`;
    let name = base;
    for (let n = 2; headers.includes(name); n++) name = `${base} (${n})`;
    headers.push(name);
  }
  return { headers, rows, hasHeader };
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Header names each field is known by, most specific first. */
const SYNONYMS: Record<MappingField, string[]> = {
  date: ['transaction date', 'trans date', 'date', 'posted date', 'post date', 'posting date', 'booking date', 'value date'],
  description: ['description', 'transaction description', 'payee', 'merchant', 'merchant name', 'name', 'details', 'narrative', 'memo'],
  amount: ['amount', 'transaction amount', 'amount usd', 'net amount', 'value'],
  debit: ['debit', 'debits', 'debit amount', 'withdrawal', 'withdrawals', 'withdrawal amount', 'money out', 'paid out'],
  credit: ['credit', 'credits', 'credit amount', 'deposit', 'deposits', 'deposit amount', 'money in', 'paid in'],
  category: ['category', 'transaction category'],
};

/** Columns that only appear in card-statement exports where charges are positive. */
const POSITIVE_SPEND_HINTS = ['card member', 'extended details', 'appears on your statement as'];

function findColumn(headers: string[], field: MappingField, taken: Set<string>): string | undefined {
  const names = headers.map(norm);
  for (const syn of SYNONYMS[field]) {
    const i = names.findIndex((n, j) => n === syn && !taken.has(headers[j]));
    if (i >= 0) return headers[i];
  }
  // Loose match, e.g. "Transaction Amount (USD)" or "Date of purchase".
  const word = field === 'description' ? 'desc' : field;
  const i = names.findIndex((n, j) => n.split(' ').some((w) => w.startsWith(word)) && !taken.has(headers[j]));
  return i >= 0 ? headers[i] : undefined;
}

/**
 * Guess a mapping from header names. Prefers a single signed amount column, falling back
 * to debit/credit columns. Fields with no matching header are left unset (date and
 * description become ""), so check the result with {@link mappingProblem}.
 */
export function detectMapping(headers: string[]): CsvMapping {
  const taken = new Set<string>();
  const pick = (field: MappingField) => {
    const col = findColumn(headers, field, taken);
    if (col) taken.add(col);
    return col;
  };
  const date = pick('date') ?? '';
  const description = pick('description') ?? '';
  const amount = pick('amount');
  const mapping: CsvMapping = { date, description };
  if (amount) mapping.amount = amount;
  else {
    const debit = pick('debit');
    const credit = pick('credit');
    if (debit) mapping.debit = debit;
    if (credit) mapping.credit = credit;
  }
  const category = pick('category');
  if (category) mapping.category = category;
  if (headers.some((h) => POSITIVE_SPEND_HINTS.includes(norm(h)))) mapping.negate = true;
  return mapping;
}

/** Why `mapping` cannot be used with `headers`, or undefined if it can. */
export function mappingProblem(mapping: CsvMapping, headers: string[]): string | undefined {
  const has = (col?: string) => col !== undefined && headers.includes(col);
  if (!has(mapping.date)) return 'Choose the column that holds the date.';
  if (!has(mapping.description)) return 'Choose the column that holds the description.';
  if (mapping.amount !== undefined) return has(mapping.amount) ? undefined : 'Choose the column that holds the amount.';
  if (!has(mapping.debit) && !has(mapping.credit)) return 'Choose a debit or credit column.';
  for (const col of [mapping.debit, mapping.credit, mapping.category]) {
    if (col !== undefined && !has(col)) return `The column "${col}" is not in this file.`;
  }
  return undefined;
}

/** `saved` if it fits these headers, else a fresh guess from them. */
export function mappingFor(headers: string[], saved?: CsvMapping): CsvMapping {
  return saved && !mappingProblem(saved, headers) ? saved : detectMapping(headers);
}

/**
 * The decimal separator the file's mapped amount, debit and credit cells are written with,
 * if they show it (see {@link detectDecimal}).
 */
export function detectSeparator(table: CsvTable, mapping: CsvMapping): DecimalSeparator | undefined {
  const cols = [mapping.amount, mapping.debit, mapping.credit].map((c) => (c === undefined ? -1 : table.headers.indexOf(c)));
  return detectDecimal(table.rows.flatMap((r) => cols.filter((i) => i >= 0).map((i) => r[i] ?? '')));
}

/**
 * The decimal separator bank exports in `currency` almost always use, only offered as a choice
 * for ambiguous rows, never applied unasked. Currencies whose exports commonly use either
 * (CHF, SEK, …) are left out.
 */
const CURRENCY_DECIMAL: Record<string, DecimalSeparator> = {
  USD: '.', GBP: '.', CAD: '.', AUD: '.', NZD: '.', JPY: '.', CNY: '.', INR: '.', MXN: '.', SGD: '.',
  EUR: ',', BRL: ',',
};

export const currencyDecimal = (currency?: string): DecimalSeparator | undefined =>
  currency ? CURRENCY_DECIMAL[currency] : undefined;

/** The separator amounts are read with: the mapping's, else the file's, else none, so ambiguous amounts fail. */
export function decimalFor(table: CsvTable, mapping: CsvMapping): DecimalSeparator | undefined {
  return mapping.decimal ?? detectSeparator(table, mapping);
}

export interface MappingOptions {
  /**
   * `mapping.decimal` was loaded from a saved mapping rather than chosen for this import. It then
   * settles amounts that read differently with each separator only if the file's rows show the
   * same separator; otherwise those rows are ambiguous errors.
   */
  savedDecimal?: boolean;
}

type Cell = { ok: true; value: number } | { ok: false; reason: string; kind?: 'ambiguous' };

function mappedAmount(get: (col?: string) => string, m: CsvMapping, decimal: DecimalSeparator | undefined, settled: boolean): Cell {
  const parse = (col: string | undefined, label: string): Cell => {
    const raw = get(col);
    if (!raw) return { ok: true, value: 0 };
    const value = !settled && readAmount(raw) === 'ambiguous' ? 'ambiguous' : readAmount(raw, decimal);
    if (value === 'ambiguous') return { ok: false, reason: `Ambiguous ${label} "${raw}": choose the decimal separator`, kind: 'ambiguous' };
    return value === null ? { ok: false, reason: `Unreadable ${label} "${raw}"` } : { ok: true, value };
  };
  if (m.amount !== undefined) {
    if (!get(m.amount)) return { ok: false, reason: 'Missing amount' };
    return parse(m.amount, 'amount');
  }
  if (!get(m.debit) && !get(m.credit)) return { ok: false, reason: 'Missing amount' };
  const debit = parse(m.debit, 'debit');
  if (!debit.ok) return debit;
  const credit = parse(m.credit, 'credit');
  if (!credit.ok) return credit;
  return { ok: true, value: Math.abs(credit.value) - Math.abs(debit.value) };
}

/**
 * Turn table rows into transactions for `accountId` using `mapping`. Rows with a bad
 * date, description or amount become {@link RowError}s instead, as do amounts that read
 * differently with each decimal separator when neither the mapping nor the file settles
 * one (see {@link decimalFor}), or when a saved separator is not backed by the file's rows (see
 * {@link MappingOptions}). Amounts are rounded to cents. Ids are content hashes
 * (see {@link contentIds}), so mapping the same file again yields the same transactions.
 */
export function applyMapping(table: CsvTable, mapping: CsvMapping, accountId: string, options: MappingOptions = {}): MappedRows {
  const problem = mappingProblem(mapping, table.headers);
  if (problem) throw new Error(problem);
  const col = new Map(table.headers.map((h, i) => [h, i]));
  const idFor = contentIds();
  const transactions: Transaction[] = [];
  const errors: RowError[] = [];
  const offset = table.hasHeader ? 2 : 1;
  const decimal = decimalFor(table, mapping);
  const settled = !options.savedDecimal || !mapping.decimal || detectSeparator(table, mapping) === mapping.decimal;

  table.rows.forEach((cells, i) => {
    const get = (c?: string) => (c === undefined ? '' : (cells[col.get(c)!] ?? '').trim());
    const fail = (reason: string, kind?: 'ambiguous') => errors.push({ row: i + offset, cells, reason, ...(kind && { kind }) });
    const date = normalizeDate(get(mapping.date));
    if (!date) return fail(get(mapping.date) ? `Unreadable date "${get(mapping.date)}"` : 'Missing date');
    const description = get(mapping.description).replace(/\s+/g, ' ');
    if (!description) return fail('Missing description');
    const amount = mappedAmount(get, mapping, decimal, settled);
    if (!amount.ok) return fail(amount.reason, amount.kind);
    // Credit minus debit can pick up binary error; `|| 0` turns -0 into 0.
    const value = Math.round((mapping.negate ? -amount.value : amount.value) * 100) / 100 || 0;
    const externalId = idFor(date, description, value, accountId);
    transactions.push({
      id: `csv-${externalId}`,
      externalId,
      date,
      description,
      amount: value,
      category: get(mapping.category) || 'Other',
      accountId,
    });
  });
  return { transactions, errors };
}

/** The rows that failed, as CSV in the original columns plus a trailing "Error" column. */
export function errorRowsCsv(table: CsvTable, errors: RowError[]): string {
  const width = table.headers.length;
  const pad = (cells: string[]) => Array.from({ length: width }, (_, i) => cells[i] ?? '');
  return toCsv([
    [...table.headers, 'Error'],
    ...errors.map((e) => [...pad(e.cells), `Row ${e.row}: ${e.reason}`]),
  ]);
}

/** Remember `mapping` as the one to offer next time a CSV is imported into `accountId`. */
export function withImportMapping(state: LedgerState, accountId: string, mapping: CsvMapping): LedgerState {
  return { ...state, importMappings: { ...state.importMappings, [accountId]: { ...mapping } } };
}
