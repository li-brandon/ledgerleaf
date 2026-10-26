import { csvCell } from './csvExport';
import { hashId } from './sync/hash';
import type { Account, DateOrder, DecimalSeparator, Transaction } from './types';

/**
 * Split CSV text into rows of cells. Handles quoted fields, escaped quotes and CRLF. A quote
 * only opens a quoted field at the start of a cell; elsewhere (`12" PIZZA`) it is literal.
 */
export function parseCsvRows(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  /** Whether the current cell has begun (a quoted section counts). */
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !started) quoted = started = true;
    else if (c === ',') { row.push(cell); cell = ''; started = false; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = ''; started = false;
    } else { cell += c; started = true; }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
/** 1-based month from a full or abbreviated English name ("Sep", "Sept", "September"), else NaN. */
const month = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase())) + 1 || NaN;
/** Two-digit years are read as 2000–2069 or 1970–1999. */
const fullYear = (y: string) => (y.length === 2 ? (+y < 70 ? 2000 + +y : 1900 + +y) : +y);

const DATE_ORDERS: DateOrder[] = ['MDY', 'DMY', 'YMD'];

/**
 * `raw` as YYYY-MM-DD under each date order it can be written in, null where that reading is not
 * a real date. A numeric date with the year last (12/31/2026, 31.12.2026, 1-5-26) is month or day
 * first, never year first. One with a four-digit year first (2026-12-31, also with a time) or a
 * month name (DD MMM YYYY, "DD-MMM-YY", MMM DD, YYYY) reads the same under every order.
 * Numbers may be separated by "/", "." or "-".
 */
function dateReadings(raw: string): Partial<Record<DateOrder, string | null>> {
  const s = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return every(fmt(+m[1], +m[2], +m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(s);
  if (m) return { MDY: fmt(fullYear(m[3]), +m[1], +m[2]), DMY: fmt(fullYear(m[3]), +m[2], +m[1]) };
  let named: string | null = null;
  m = /^(\d{1,2})[ -]([a-z]{3,9})\.?[ ,-]+(\d{4}|\d{2})$/i.exec(s);
  if (m) named = fmt(fullYear(m[3]), month(m[2]), +m[1]);
  m = /^([a-z]{3,9})\.? (\d{1,2}),? (\d{4})$/i.exec(s);
  if (m) named = fmt(+m[3], month(m[1]), +m[2]);
  return named ? every(named) : {};
}

const every = (date: string | null) => ({ MDY: date, DMY: date, YMD: date });

/**
 * Reads a date written in `order` (see {@link dateReadings} for the formats). Dates with a
 * four-digit year first or a month name are read whatever the order; under YMD, year-last dates
 * are not. Returns YYYY-MM-DD or null.
 */
export function normalizeDate(raw: string, order: DateOrder = 'MDY'): string | null {
  return dateReadings(raw)[order] ?? null;
}

/**
 * Read a date whose order may be unknown. Without `order`, a date is read if it means the same
 * under every order it is valid in ("05/05/2026", "13/01/2026", "2026-12-31"); "01/02/2026"
 * could be 2 January or 1 February, so it is 'ambiguous'. Null if not a date.
 */
export function readDate(raw: string, order?: DateOrder): string | null | 'ambiguous' {
  if (order) return normalizeDate(raw, order);
  const dates = new Set(Object.values(dateReadings(raw)).filter((d) => d));
  return dates.size > 1 ? 'ambiguous' : [...dates][0] ?? null;
}

/**
 * The date order `values` are written in: the one order every value that is a date in only some
 * orders agrees with ("13/01/2026" is day first, "01/13/2026" month first). ISO and month-name dates
 * read the same in every order, so they tell nothing. Undefined when no value tells, or values disagree.
 */
export function detectDateOrder(values: string[]): DateOrder | undefined {
  let left = DATE_ORDERS;
  for (const v of values) {
    const r = dateReadings(v);
    const valid = DATE_ORDERS.filter((o) => r[o]);
    if (valid.length && valid.length < DATE_ORDERS.length) left = left.filter((o) => valid.includes(o));
  }
  return left.length === 1 ? left[0] : undefined;
}

function fmt(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Minus signs and dashes banks and spreadsheets write in place of "-": hyphens, figure/en/em dashes, U+2212, small and fullwidth hyphen-minus. */
const MINUS = /[‐-―−﹘﹣－]/g;

/**
 * A number written with each decimal separator. Thousands are grouped in threes by one kind
 * of separator throughout: the other of "." and ",", or a space. With a decimal point, Indian
 * lakh grouping ("12,34,567") is accepted too.
 */
const AMOUNT = {
  '.': /^[-+]?([1-9]\d{0,2}([, ])\d{3}(\2\d{3})*|[1-9]\d?(,\d\d)+,\d{3}|\d*)(\.\d+)?$/,
  ',': /^[-+]?([1-9]\d{0,2}([. ])\d{3}(\2\d{3})*|\d*)(,\d+)?$/,
};

/**
 * Parses "$1,234.50", "-12", "(45.00)", "-$5", "€12.00", "1,234.56-", "12.00 USD" and
 * "1,23,456.78", or with `decimal` ",": "1.234,56", "1 234,56" and "12,50". Thousands must be
 * grouped as {@link AMOUNT} allows. Rounds to cents. Returns null if not numeric.
 */
export function parseAmount(raw: string, decimal: DecimalSeparator = '.'): number | null {
  // Whitespace between two digits can only group thousands; elsewhere it is dropped.
  let s = raw.replace(MINUS, '-').replace(/\b[A-Z]{3}\b|[$€£¥]/g, '').replace(/(?<!\d)\s+|\s+(?!\d)/g, '').replace(/\s/g, ' ');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^[^-+]*-$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
  if (!/\d/.test(s) || !AMOUNT[decimal].test(s)) return null;
  const plain = s.replace(decimal === '.' ? /[, ]/g : /[. ]/g, '').replace(',', '.');
  // Rounding the "e2"-shifted text avoids binary error: 1.005 rounds to 1.01. Halves round away from zero.
  const n = Math.sign(Number(plain)) * Math.round(Math.abs(Number(`${plain}e2`))) / 100;
  return (neg ? -n : n) || 0;
}

/**
 * Read an amount whose decimal separator may be unknown. Without `decimal`, a value is read
 * if it means the same with either separator ("-12", "12.50", "1.234,56"); "1,234" could
 * be 1234 or 1.234, so it is 'ambiguous'. Null if not numeric.
 */
export function readAmount(raw: string, decimal?: DecimalSeparator): number | null | 'ambiguous' {
  if (decimal) return parseAmount(raw, decimal);
  const point = parseAmount(raw, '.');
  const comma = parseAmount(raw, ',');
  return point !== null && comma !== null && point !== comma ? 'ambiguous' : point ?? comma;
}

/**
 * The decimal separator `values` are written with: the one separator that some value can
 * only be read with ("12,50", "1,234.56"). Undefined when no value tells, or values disagree.
 */
export function detectDecimal(values: string[]): DecimalSeparator | undefined {
  const seen = new Set<DecimalSeparator>();
  for (const v of values) {
    const point = parseAmount(v, '.') !== null;
    if (point !== (parseAmount(v, ',') !== null)) seen.add(point ? '.' : ',');
  }
  return seen.size === 1 ? [...seen][0] : undefined;
}

export const slug = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'imported';

/**
 * Content-hash ids for CSV rows: the row's date, description, amount and account plus how
 * many identical rows came before it in the file. Re-importing a file gives the same ids,
 * so dedupe applies, while genuine same-day repeats are kept apart.
 */
export function contentIds() {
  const occurrences = new Map<string, number>();
  return (date: string, description: string, amount: number, accountId: string) => {
    const key = [date, description.toLowerCase(), amount.toFixed(2), accountId].join('|');
    const n = occurrences.get(key) ?? 0;
    occurrences.set(key, n + 1);
    return hashId(`${key}#${n}`);
  };
}

/**
 * Serialise rows as CSV, escaping each cell with {@link csvCell}. Plain negative numbers such
 * as "-12.50" cannot run as formulas, so they are written as-is and still re-import as amounts.
 */
export function toCsv(rows: string[][]): string {
  const cell = (v: string) => (/^-\d+(\.\d+)?$/.test(v) ? v : csvCell(v));
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export interface CsvParseResult {
  accounts: Account[];
  transactions: Transaction[];
  skipped: number;
}

const COLUMNS = ['date', 'description', 'amount', 'category', 'account'] as const;

/**
 * Parse CSV with columns date,description,amount,category,account (header optional,
 * header order respected). The decimal separator is detected from the amounts and the date
 * order from the dates; rows whose amount or date stays ambiguous are skipped (see
 * {@link readAmount} and {@link readDate}). Ids hash the row content plus its occurrence index, so
 * re-importing the same file dedupes while genuine same-day repeats are kept.
 */
export function parseTransactionsCsv(text: string): CsvParseResult {
  const rows = parseCsvRows(text);
  let idx: Record<(typeof COLUMNS)[number], number> = { date: 0, description: 1, amount: 2, category: 3, account: 4 };
  if (rows[0] && rows[0].map((h) => h.trim().toLowerCase()).includes('date')) {
    const header = rows.shift()!.map((h) => h.trim().toLowerCase());
    idx = Object.fromEntries(COLUMNS.map((c) => [c, header.indexOf(c)])) as typeof idx;
  }
  const accounts = new Map<string, Account>();
  const transactions: Transaction[] = [];
  const idFor = contentIds();
  const decimal = detectDecimal(idx.amount >= 0 ? rows.map((r) => r[idx.amount] ?? '') : []);
  const order = detectDateOrder(idx.date >= 0 ? rows.map((r) => r[idx.date] ?? '') : []);
  let skipped = 0;
  for (const r of rows) {
    const get = (c: (typeof COLUMNS)[number]) => (idx[c] >= 0 ? (r[idx[c]] ?? '').trim() : '');
    const date = readDate(get('date'), order);
    const amount = readAmount(get('amount'), decimal);
    const description = get('description');
    if (!date || date === 'ambiguous' || typeof amount !== 'number' || !description) { skipped++; continue; }
    const accountName = get('account') || 'Imported';
    const accountId = `csv-${slug(accountName)}`;
    if (!accounts.has(accountId)) accounts.set(accountId, { id: accountId, name: accountName, type: 'checking' });
    const externalId = idFor(date, description, amount, accountId);
    transactions.push({
      id: `csv-${externalId}`,
      externalId,
      date, description, amount,
      category: get('category') || 'Other',
      accountId,
    });
  }
  return { accounts: [...accounts.values()], transactions, skipped };
}
