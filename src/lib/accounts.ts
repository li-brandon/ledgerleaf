import { round } from './budget';
import { accountBalance } from './insights';
import type { Account, AccountType, Transaction } from './types';

export type AccountGroupId = 'cash' | 'credit' | 'investments' | 'loans';

/** How account types are grouped on the Accounts page, in display order. */
export const ACCOUNT_GROUPS: { id: AccountGroupId; label: string; types: AccountType[]; liability: boolean }[] = [
  { id: 'cash', label: 'Cash', types: ['checking', 'savings'], liability: false },
  { id: 'credit', label: 'Credit cards', types: ['credit'], liability: true },
  { id: 'investments', label: 'Investments', types: ['investment'], liability: false },
  { id: 'loans', label: 'Loans', types: ['loan'], liability: true },
];

/** Credit cards and loans are owed; everything else is held. */
export const isLiability = (a: Pick<Account, 'type'>) => a.type === 'credit' || a.type === 'loan';

export interface AccountRow {
  account: Account;
  balance: number;
}

export interface AccountGroup {
  id: AccountGroupId;
  label: string;
  liability: boolean;
  accounts: AccountRow[];
  /** Sum of the group's visible balances. */
  subtotal: number;
}

/**
 * Accounts grouped by type with subtotals, skipping empty groups. Hidden accounts are left
 * out unless `showHidden`, and never count towards a subtotal.
 */
export function groupAccounts(accounts: Account[], txns: Transaction[], { showHidden = false } = {}): AccountGroup[] {
  return ACCOUNT_GROUPS.flatMap(({ id, label, types, liability }) => {
    const rows = accounts
      .filter((a) => types.includes(a.type) && (showHidden || !a.hidden))
      .map((account) => ({ account, balance: accountBalance(account, txns) }));
    if (!rows.length) return [];
    const subtotal = round(rows.reduce((s, r) => (r.account.hidden ? s : s + r.balance), 0));
    return [{ id, label, liability, accounts: rows, subtotal }];
  });
}

export interface NetWorth {
  assets: number;
  /** Amount owed, as a positive number. */
  liabilities: number;
  /** assets - liabilities */
  netWorth: number;
}

/**
 * Net worth over visible accounts. Balances are signed (a card owing 500 is -500), so a
 * liability counts as minus its balance; an overpaid card reduces liabilities.
 */
export function netWorth(accounts: Account[], txns: Transaction[]): NetWorth {
  let assets = 0;
  let liabilities = 0;
  for (const a of accounts) {
    if (a.hidden) continue;
    const bal = accountBalance(a, txns);
    if (isLiability(a)) liabilities -= bal;
    else assets += bal;
  }
  assets = round(assets);
  liabilities = round(liabilities);
  return { assets, liabilities, netWorth: round(assets - liabilities) };
}

/**
 * Rename an account. Blank names are ignored. A renamed account is flagged so a re-sync
 * keeps the user's name. Returns `accounts` itself if nothing changed.
 */
export function renameAccount(accounts: Account[], id: string, name: string): Account[] {
  const trimmed = name.trim();
  const i = accounts.findIndex((a) => a.id === id);
  if (!trimmed || i < 0 || accounts[i].name === trimmed) return accounts;
  const next = [...accounts];
  next[i] = { ...accounts[i], name: trimmed, renamed: true };
  return next;
}

/** Hide or unhide an account. Returns `accounts` itself if nothing changed. */
export function setAccountHidden(accounts: Account[], id: string, hidden: boolean): Account[] {
  const i = accounts.findIndex((a) => a.id === id);
  if (i < 0 || !!accounts[i].hidden === hidden) return accounts;
  const next = [...accounts];
  next[i] = { ...accounts[i], hidden };
  return next;
}
