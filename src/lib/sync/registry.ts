import { CSV_PROVIDER, CsvImportProvider } from './csvProvider';
import { MOCK_PROVIDER, MockProvider } from './mockProvider';
import { PLAID_PROVIDER, PlaidProvider } from './plaidProvider';
import type { ProviderMeta, SyncProvider } from './types';

/** A file provider is created per file, from the file's text. */
export interface FileProviderEntry extends ProviderMeta {
  kind: 'file';
  /** `accept` attribute for the file picker. */
  accept: string;
  /** Example file contents shown to the user. */
  sample?: string;
  create(text: string): SyncProvider;
}

export interface DirectProviderEntry extends ProviderMeta {
  kind: 'demo' | 'remote';
  create(): SyncProvider;
}

/** A registered provider: its metadata plus how to make an instance to sync with. */
export type ProviderEntry = FileProviderEntry | DirectProviderEntry;

export class ProviderRegistry {
  private entries = new Map<string, ProviderEntry>();

  register(entry: ProviderEntry): this {
    if (this.entries.has(entry.id)) throw new Error(`A provider with id "${entry.id}" is already registered`);
    this.entries.set(entry.id, entry);
    return this;
  }

  get(id: string): ProviderEntry | undefined {
    return this.entries.get(id);
  }

  /** Registered providers, in registration order. */
  list(): ProviderEntry[] {
    return [...this.entries.values()];
  }
}

/**
 * The providers the app ships with. Demo and CSV are local; Plaid only talks to the
 * localhost Plaid server, and only when the user connects a bank or syncs it.
 */
export const providers = new ProviderRegistry()
  .register({ ...MOCK_PROVIDER, kind: 'demo', create: () => new MockProvider() })
  .register({
    ...CSV_PROVIDER,
    kind: 'file',
    accept: '.csv,text/csv',
    sample: 'date,description,amount,category,account\n2026-10-03,Corner Bakery,-6.25,Dining,Everyday Card',
    create: (text) => new CsvImportProvider(text),
  })
  .register({ ...PLAID_PROVIDER, kind: 'remote', create: () => new PlaidProvider() });
