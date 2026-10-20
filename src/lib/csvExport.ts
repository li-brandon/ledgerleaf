/** Transactions as CSV text, readable by spreadsheets and by Ledgerleaf's own CSV import. Pure. */
import type { Account, Transaction } from './types';

export const CSV_COLUMNS = [
  'Date', 'Description', 'Merchant', 'Category', 'Account', 'Amount', 'Currency', 'Notes', 'Reviewed', 'Id',
] as const;

/**
 * One CSV cell. Cells holding a comma, quote, line break or edge whitespace are quoted. Text
 * starting with = + - @ (or a tab / carriage return) is prefixed with ' so spreadsheets do not
 * run it as a formula; amounts are written by the caller and never pass through here as text.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]|^\s|\s$/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * CSV for `rows` in the order given, with a header row and CRLF line endings. Amounts are
 * signed (negative = money out) with two decimals; the currency column is the account's.
 */
export function transactionsToCsv(rows: readonly Transaction[], accounts: readonly Account[], fallbackCurrency = 'USD'): string {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const lines = [CSV_COLUMNS.join(',')];
  for (const t of rows) {
    const account = byId.get(t.accountId);
    lines.push([
      t.date,
      csvCell(t.description),
      csvCell(t.merchant ?? ''),
      csvCell(t.category),
      csvCell(account?.name ?? t.accountId),
      (Math.round(t.amount * 100) / 100 || 0).toFixed(2),
      account?.currency ?? fallbackCurrency,
      csvCell(t.notes ?? ''),
      t.reviewed ? 'yes' : 'no',
      csvCell(t.id),
    ].join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
