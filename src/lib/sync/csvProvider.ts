import { parseTransactionsCsv } from '../csv';
import { CSV_SOURCE, applyMapping, matchExisting, readCsvTable, type CsvTable, type RowError } from '../csvMapping';
import type { Account, CsvMapping, DeletedTransaction, Transaction } from '../types';
import type { ProviderMeta, SyncProvider } from './types';

export const CSV_PROVIDER: ProviderMeta = {
  id: CSV_SOURCE,
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
  /**
   * The ledger's transactions. Rows are matched by content to the account's CSV transactions,
   * whatever their ids (including signed ids from before LIB-379): a row matching one takes its id,
   * and one matching it except for sign is left out (see {@link matchExisting}). Without it, every
   * row is imported as mapped.
   */
  existing?: readonly Transaction[];
  /** Transactions the user deleted: rows matching one by content are left out (see {@link matchExisting}). */
  deleted?: readonly DeletedTransaction[];
}

interface Parsed {
  accounts: Account[];
  transactions: Transaction[];
  skipped: number;
  /** Per-row details, for mapped imports. */
  errors: RowError[];
  /** Rows left out as opposite-sign duplicates of existing transactions. */
  oppositeSign: number;
  /** Rows left out as matching transactions the user deleted. */
  deleted: number;
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
      return (this.parsed = { ...parseTransactionsCsv(this.text), errors: [], oppositeSign: 0, deleted: 0 });
    }
    // Read with the mapping's delimiter, else the detected one, as the import screen's preview is.
    const table = readCsvTable(this.text, o.mapping.delimiter);
    const mapped = applyMapping(table, o.mapping, o.accountId, { savedDecimal: o.savedDecimal, savedDateOrder: o.savedDateOrder });
    const { transactions, oppositeSign, deleted } = matchExisting(mapped.transactions, o.existing ?? [], o.deleted);
    const { errors } = mapped;
    return (this.parsed = {
      accounts: o.newAccount ? [o.newAccount] : [], transactions, skipped: errors.length, errors, oppositeSign: oppositeSign.size,
      deleted: deleted.size, table,
    });
  }

  /** Rows that could not be read (bad date, amount or missing description). */
  get skipped() {
    return this.parse().skipped;
  }

  /** Why each unreadable row was skipped (mapped imports only). */
  get errors(): RowError[] {
    return this.parse().errors;
  }

  /** Rows left out because they match an existing transaction except for sign (mapped imports with `existing`). */
  get oppositeSign(): number {
    return this.parse().oppositeSign;
  }

  /** Rows left out because they match a transaction the user deleted (mapped imports with `deleted`). */
  get deleted(): number {
    return this.parse().deleted;
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
