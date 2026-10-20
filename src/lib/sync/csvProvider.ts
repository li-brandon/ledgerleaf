import { parseTransactionsCsv, type CsvParseResult } from '../csv';
import type { ProviderMeta, SyncProvider } from './types';

export const CSV_PROVIDER: ProviderMeta = {
  id: 'csv',
  name: 'CSV import',
  kind: 'file',
  requiresAuth: false,
  description: 'Columns: date,description,amount,category,account. Negative amounts are spending. Re-importing a file skips rows already present.',
};

/** Reads transactions from CSV text. A file is a complete snapshot, so `since` is ignored. */
export class CsvImportProvider implements SyncProvider {
  readonly id = CSV_PROVIDER.id;
  readonly name = CSV_PROVIDER.name;
  readonly kind = CSV_PROVIDER.kind;
  readonly requiresAuth = CSV_PROVIDER.requiresAuth;
  readonly description = CSV_PROVIDER.description;
  private parsed?: CsvParseResult;

  constructor(private text: string) {}

  private parse() {
    return (this.parsed ??= parseTransactionsCsv(this.text));
  }

  /** Rows that could not be read (bad date, amount or missing description). */
  get skipped() {
    return this.parse().skipped;
  }

  async listAccounts() {
    return this.parse().accounts.map((a) => ({ ...a }));
  }

  async fetchTransactions() {
    return this.parse().transactions.map((t) => ({ ...t }));
  }
}
