import { csvCell } from './csvExport';
import { hashId } from './sync/hash';
import type { Account, Transaction } from './types';

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

/**
 * Accepts YYYY-MM-DD, YYYY/MM/DD, MM/DD/YYYY, M/D/YY (also with dashes), DD MMM YYYY
 * (also "DD-MMM-YY") and MMM DD, YYYY. Slashed dates are month first, as US banks export
 * them. Returns YYYY-MM-DD or null.
 */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return fmt(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(s);
  if (m) return fmt(fullYear(m[3]), +m[1], +m[2]);
  m = /^(\d{1,2})[ -]([a-z]{3,9})\.?[ ,-]+(\d{4}|\d{2})$/i.exec(s);
  if (m) return fmt(fullYear(m[3]), month(m[2]), +m[1]);
  m = /^([a-z]{3,9})\.? (\d{1,2}),? (\d{4})$/i.exec(s);
  if (m) return fmt(+m[3], month(m[1]), +m[2]);
  return null;
}

function fmt(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Parses "$1,234.50", "-12", "(45.00)", "-$5", "€12.00", "1,234.56-" and "12.00 USD".
 * Commas are thousands separators. Returns null if not numeric.
 */
export function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/\b[A-Z]{3}\b|[$€£¥\s,]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^[^-+]*-$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
  if (!/^[-+]?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return neg ? -n : n;
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
 * header order respected). Ids hash the row content plus its occurrence index, so
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
  let skipped = 0;
  for (const r of rows) {
    const get = (c: (typeof COLUMNS)[number]) => (idx[c] >= 0 ? (r[idx[c]] ?? '').trim() : '');
    const date = normalizeDate(get('date'));
    const amount = parseAmount(get('amount'));
    const description = get('description');
    if (!date || amount === null || !description) { skipped++; continue; }
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
