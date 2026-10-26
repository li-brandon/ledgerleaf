import { csvCell } from './csvExport';
import { hashId } from './sync/hash';
import type { Account, CsvDelimiter, DateOrder, DecimalSeparator, Transaction } from './types';

/**
 * Split CSV text into rows of cells, separated by `delimiter`. Handles quoted fields, escaped
 * quotes and CRLF; a delimiter inside quotes is part of the cell. A quote only opens a quoted
 * field at the start of a cell; elsewhere (`12" PIZZA`) it is literal.
 */
export function parseCsvRows(text: string, delimiter: CsvDelimiter = ','): string[][] {
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
    else if (c === delimiter) { row.push(cell); cell = ''; started = false; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = ''; started = false;
    } else { cell += c; started = true; }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

/** Delimiters {@link detectDelimiter} chooses from, in the order ties go. */
export const DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t'];

/** Lines of a file {@link detectDelimiter} looks at. */
const SAMPLE_LINES = 20;

/**
 * The delimiter a file's cells are separated by: the one that splits the header and the next
 * rows (up to {@link SAMPLE_LINES} lines) into the same number of cells, more than one, on every
 * row. Delimiters inside quotes don't count, and ones that only appear in some cells (12,50 in a
 * semicolon file) give uneven rows. If several fit, the one giving the most columns wins, then
 * the first of {@link DELIMITERS}. Comma when none fits, as in a single-column file.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const lines = text.split(/\r\n|\n|\r/, SAMPLE_LINES + 1);
  const sample = lines.slice(0, SAMPLE_LINES).join('\n');
  let best: CsvDelimiter = ',';
  let width = 1;
  for (const d of DELIMITERS) {
    const rows = parseCsvRows(sample, d);
    // Cut off by the end of the sample, the last row may lack cells (a quoted line break).
    if (lines.length > SAMPLE_LINES && rows.length > 1) rows.pop();
    const n = rows[0]?.length ?? 0;
    if (n > width && rows.every((r) => r.length === n)) { best = d; width = n; }
  }
  return best;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
/** 1-based month from a full or abbreviated English name ("Sep", "Sept", "September"), else NaN. */
const month = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase())) + 1 || NaN;
/** Two-digit years are read as 2000–2069 or 1970–1999. */
const fullYear = (y: string) => (y.length === 2 ? (+y < 70 ? 2000 + +y : 1900 + +y) : +y);

/**
 * `raw` as YYYY-MM-DD under each date order it can be written in, null where that reading is not
 * a real date. A numeric date with a four-digit year last (12/31/2026, 31.12.2026) is month or day
 * first, never year first. One of three two-digit numbers (12-31-26, 25-10-01) may also be year
 * first. One with a four-digit year first (2026-12-31, also with a time) or a month name
 * (DD MMM YYYY, "DD-MMM-YY", MMM DD, YYYY) reads the same under every order.
 * Numbers may be separated by "/", "." or "-".
 */
function dateReadings(raw: string): Partial<Record<DateOrder, string | null>> {
  const s = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return every(fmt(+m[1], +m[2], +m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(s);
  if (m) {
    const r = { MDY: fmt(fullYear(m[3]), +m[1], +m[2]), DMY: fmt(fullYear(m[3]), +m[2], +m[1]) };
    return m[1].length === 2 && m[3].length === 2 ? { ...r, YMD: fmt(fullYear(m[1]), +m[2], +m[3]) } : r;
  }
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
 * four-digit year first or a month name are read whatever the order; under YMD, dates with a
 * four-digit year last are not. Returns YYYY-MM-DD or null.
 */
export function normalizeDate(raw: string, order: DateOrder = 'MDY'): string | null {
  return dateReadings(raw)[order] ?? null;
}

/**
 * Read a date whose order may be unknown. Without `order`, a date is read only if it is the same
 * date under every order it can be written in ("05/05/2026", "05/05/05", "2026-12-31");
 * "01/02/2026" could be 2 January or 1 February, and "13/01/2026" is only a date day first, so
 * both are 'ambiguous'. An order only `detected` from the rows (see {@link detectDateOrder})
 * settles month against day first, not whether a two-digit year comes first: a date that is also
 * a different date year first ("25-10-01") stays 'ambiguous'. Null if not a date.
 */
export function readDate(raw: string, order?: DateOrder, detected = false): string | null | 'ambiguous' {
  const r = dateReadings(raw);
  if (order) return detected && r.YMD && r.YMD !== r[order] ? 'ambiguous' : r[order] ?? null;
  const dates = new Set(Object.values(r));
  return dates.size > 1 ? 'ambiguous' : [...dates][0] ?? null;
}

/** Whether `raw` is a different real date in two orders ("01/02/2026", "25-10-01"), so only an order can settle it. */
export const ambiguousDate = (raw: string) => new Set(Object.values(dateReadings(raw)).filter((d) => d)).size > 1;

/**
 * The date order `values` are written in: the one order every value that is a date in only one of
 * month and day first agrees with ("13/01/2026" is day first, "01/13/2026" month first). Only dates
 * with a four-digit year last tell: ISO and month-name dates read the same in every order, and a
 * two-digit year may come first ("25-10-01"). Undefined when no value tells, or values disagree.
 */
export function detectDateOrder(values: string[]): DateOrder | undefined {
  const telling = values.filter((v) => !/\D\d\d$/.test(v.trim())).map(dateReadings).filter((r) => !r.MDY !== !r.DMY);
  const orders = new Set(telling.map((r): DateOrder => (r.MDY ? 'MDY' : 'DMY')));
  return orders.size === 1 ? [...orders][0] : undefined;
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
 * Parses "$1,234.50", "-12", "(45.00)", "-$5", "€12.00", "1,234.56-", "12.00 USD" (or "usd") and
 * "1,23,456.78", or with `decimal` ",": "1.234,56", "1 234,56" and "12,50". Thousands must be
 * grouped as {@link AMOUNT} allows. Rounds to cents. Returns null if not numeric.
 */
export function parseAmount(raw: string, decimal: DecimalSeparator = '.'): number | null {
  // Whitespace between two digits can only group thousands; elsewhere it is dropped.
  let s = raw.replace(MINUS, '-').replace(/\b[a-z]{3}\b|[$€£¥]/gi, '').replace(/(?<!\d)\s+|\s+(?!\d)/g, '').replace(/\s/g, ' ');
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

const idKey = (date: string, description: string, amount: number, accountId: string) =>
  [date, description.toLowerCase(), amount.toFixed(2), accountId].join('|');

function hashedIds(signed: boolean) {
  const occurrences = new Map<string, number>();
  return (date: string, description: string, amount: number, accountId: string) => {
    const key = idKey(date, description, signed ? amount : Math.abs(amount), accountId);
    const n = occurrences.get(key) ?? 0;
    occurrences.set(key, n + 1);
    return signed ? hashId(`${key}#${n}`) : contentId(date, description, amount, accountId, n);
  };
}

/** The {@link contentIds} id of the row with these values that has `n` such rows before it. */
export const contentId = (date: string, description: string, amount: number, accountId: string, n: number) =>
  // The prefix keeps these ids apart from signed ones, which hash the same text for positive amounts.
  hashId(`unsigned|${idKey(date, description, Math.abs(amount), accountId)}#${n}`);

/**
 * Content-hash ids for CSV rows: the row's date, description, absolute amount and account plus
 * how many rows with the same values came before it in the file. Re-importing a file gives the
 * same ids whatever its signs, while genuine same-day repeats (and rows differing only in sign)
 * are kept apart.
 */
export const contentIds = () => hashedIds(false);

/**
 * Ids as {@link contentIds} made them before LIB-379, from the signed amount. Transactions
 * imported then keep them; mapped imports match stored rows by content, not id (see
 * `matchExisting` in csvMapping), so only {@link parseTransactionsCsv} still uses them.
 */
export const signedContentIds = () => hashedIds(true);

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
 * header order respected). The delimiter is detected (see {@link detectDelimiter}), the decimal
 * separator from the amounts and the date order from the dates; rows whose amount or date stays
 * ambiguous are skipped (see {@link readAmount} and {@link readDate}). Ids hash the row content plus its occurrence index, so
 * re-importing the same file dedupes while genuine same-day repeats are kept. This parser has no
 * sign flip, so it keeps the signed ids ({@link signedContentIds}): every id it has stored stays
 * valid without needing to see the ledger.
 */
export function parseTransactionsCsv(text: string): CsvParseResult {
  const rows = parseCsvRows(text, detectDelimiter(text));
  let idx: Record<(typeof COLUMNS)[number], number> = { date: 0, description: 1, amount: 2, category: 3, account: 4 };
  if (rows[0] && rows[0].map((h) => h.trim().toLowerCase()).includes('date')) {
    const header = rows.shift()!.map((h) => h.trim().toLowerCase());
    idx = Object.fromEntries(COLUMNS.map((c) => [c, header.indexOf(c)])) as typeof idx;
  }
  const accounts = new Map<string, Account>();
  const transactions: Transaction[] = [];
  const idFor = signedContentIds();
  const decimal = detectDecimal(idx.amount >= 0 ? rows.map((r) => r[idx.amount] ?? '') : []);
  const order = detectDateOrder(idx.date >= 0 ? rows.map((r) => r[idx.date] ?? '') : []);
  let skipped = 0;
  for (const r of rows) {
    const get = (c: (typeof COLUMNS)[number]) => (idx[c] >= 0 ? (r[idx[c]] ?? '').trim() : '');
    const date = readDate(get('date'), order, true);
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
