import { parseTransactionsCsv } from '../csv';
import { applyMapping, readCsvTable, type CsvTable, type RowError } from '../csvMapping';
import type { Account, CsvMapping, Transaction } from '../types';
import type { ProviderMeta, SyncProvider } from './types';

export const CSV_PROVIDER: ProviderMeta = {
  id: 'csv',
  name: 'CSV import',
  kind: 'file',
  requiresAuth: false,
  description: 'Import a bank or card export. Pick which columns hold the date, description and amount; Ledgerleaf remembers the choice per account. Re-importing a file skips rows already present.',
};

/** Import every row into one account using an explicit column mapping. */
export interface CsvImportOptions {
  mapping: CsvMapping;
  /** Id of the account every row is imported into. */
  accountId: string;
  /** Set when the target account does not exist yet; it is created by the sync. */
  newAccount?: Account;
  /** `mapping.decimal` is the account's saved one, not chosen for this file (see {@link applyMapping}). */
  savedDecimal?: boolean;
  /** `mapping.dateOrder` is the account's saved one, not chosen for this file (see {@link applyMapping}). */
  savedDateOrder?: boolean;
}

interface Parsed {
  accounts: Account[];
  transactions: Transaction[];
  skipped: number;
  /** Per-row details, for mapped imports. */
  errors: RowError[];
  table?: CsvTable;
}

/**
 * Reads transactions from CSV text. A file is a complete snapshot, so `since` is ignored.
 * With options, rows are read through a column mapping into one account; without, the file
 * must use the columns date,description,amount,category,account.
 */
export class CsvImportProvider implements SyncProvider {
  readonly id = CSV_PROVIDER.id;
  readonly name = CSV_PROVIDER.name;
  readonly kind = CSV_PROVIDER.kind;
  readonly requiresAuth = CSV_PROVIDER.requiresAuth;
  readonly description = CSV_PROVIDER.description;
  private parsed?: Parsed;

  constructor(private text: string, private options?: CsvImportOptions) {}

  private parse(): Parsed {
    if (this.parsed) return this.parsed;
    const o = this.options;
    if (!o) {
      return (this.parsed = { ...parseTransactionsCsv(this.text), errors: [] });
    }
    const table = readCsvTable(this.text);
    const { transactions, errors } = applyMapping(table, o.mapping, o.accountId, { savedDecimal: o.savedDecimal, savedDateOrder: o.savedDateOrder });
    return (this.parsed = { accounts: o.newAccount ? [o.newAccount] : [], transactions, skipped: errors.length, errors, table });
  }

  /** Rows that could not be read (bad date, amount or missing description). */
  get skipped() {
    return this.parse().skipped;
  }

  /** Why each unreadable row was skipped (mapped imports only). */
  get errors(): RowError[] {
    return this.parse().errors;
  }

  /** The parsed file, for mapped imports. */
  get table(): CsvTable | undefined {
    return this.parse().table;
  }

  async listAccounts() {
    return this.parse().accounts.map((a) => ({ ...a }));
  }

  async fetchTransactions() {
    return this.parse().transactions.map((t) => ({ ...t }));
  }
}
