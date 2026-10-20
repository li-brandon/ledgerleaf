import type { Account, Transaction } from '../types';

export interface SyncResult {
  accounts: Account[];
  transactions: Transaction[];
}

export interface SyncProvider {
  id: string;
  name: string;
  sync(): Promise<SyncResult>;
}
