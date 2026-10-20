import { parseTransactionsCsv } from '../csv';
import type { SyncProvider, SyncResult } from './types';

export class CsvImportProvider implements SyncProvider {
  id = 'csv';
  name = 'CSV import';
  skipped = 0;
  constructor(private text: string) {}

  async sync(): Promise<SyncResult> {
    const { accounts, transactions, skipped } = parseTransactionsCsv(this.text);
    this.skipped = skipped;
    return { accounts, transactions };
  }
}
