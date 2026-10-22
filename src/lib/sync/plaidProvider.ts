import type { Account, AccountType, Transaction } from '../types';
import type { AccountBalance, ProviderMeta, RemoteSyncProvider, RemovedTransaction } from './types';

export const PLAID_PROVIDER: ProviderMeta = {
  id: 'plaid',
  name: 'Bank via Plaid (sandbox)',
  kind: 'remote',
  requiresAuth: true,
  description: 'Connect a bank with Plaid Link. Needs the local Plaid server (npm run plaid-server), which keeps your keys and access tokens on this machine; the browser only ever talks to it.',
};

/** Where the local Plaid server is mounted (proxied by the Vite dev server). */
export const PLAID_API = '/api/plaid';

// Wire shapes: the parts of Plaid's objects the app reads, as relayed by server/plaid-server.mjs.

export interface PlaidAccount {
  account_id: string;
  item_id?: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  balances?: { current?: number | null; available?: number | null; iso_currency_code?: string | null; unofficial_currency_code?: string | null };
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Positive = money out (Plaid's convention). */
  amount: number;
  date: string;
  name?: string | null;
  merchant_name?: string | null;
  pending: boolean;
  personal_finance_category?: { primary?: string; detailed?: string } | null;
}

export interface PlaidItem {
  item_id: string;
  institution: { id?: string; name?: string } | null;
  last_sync: string | null;
  last_error: { code: string; message: string; at: string } | null;
  transactions_update_status?: string | null;
}

export interface PlaidItemError {
  item_id: string;
  institution: PlaidItem['institution'];
  code: string;
  message: string;
}

export interface PlaidSyncResponse {
  items: PlaidItem[];
  accounts: PlaidAccount[];
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string; account_id?: string }[];
  errors?: PlaidItemError[];
}

export interface PlaidStatus {
  configured: boolean;
  env: string;
  items: PlaidItem[];
}

/** The app's id for a Plaid account. */
export const plaidAccountId = (accountId: string) => `${PLAID_PROVIDER.id}-${accountId}`;

const round = (n: number) => Math.round(n * 100) / 100;

function accountType(a: PlaidAccount): AccountType {
  if (a.type === 'credit') return 'credit';
  if (a.type === 'loan') return 'loan';
  if (a.type === 'investment' || a.type === 'brokerage') return 'investment';
  if (a.type === 'depository' && /savings|money market|cd|hsa/i.test(a.subtype ?? '')) return 'savings';
  return 'checking';
}

/**
 * The account's balance in the app's convention. Plaid reports what is owed on credit and
 * loan accounts as a positive number; the ledger counts it as negative.
 */
export function plaidBalance(a: PlaidAccount): number | undefined {
  const raw = a.balances?.current ?? a.balances?.available;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const owed = a.type === 'credit' || a.type === 'loan';
  return round(owed ? -raw : raw) + 0;
}

export function mapPlaidAccount(a: PlaidAccount, institution?: string): Account {
  const out: Account = {
    id: plaidAccountId(a.account_id),
    name: a.mask ? `${a.name} ••${a.mask}` : a.name,
    type: accountType(a),
    currency: a.balances?.iso_currency_code ?? a.balances?.unofficial_currency_code ?? 'USD',
  };
  if (institution) out.institution = institution;
  const balance = plaidBalance(a);
  if (balance !== undefined) out.balance = balance;
  return out;
}

/** Plaid personal finance categories (primary, or detailed when it is more specific) to app categories. */
const CATEGORY_BY_PFC: Record<string, string> = {
  FOOD_AND_DRINK_GROCERIES: 'Groceries',
  FOOD_AND_DRINK: 'Dining',
  RENT_AND_UTILITIES_RENT: 'Rent',
  RENT_AND_UTILITIES: 'Utilities',
  TRANSPORTATION: 'Transport',
  TRAVEL: 'Travel',
  GENERAL_MERCHANDISE: 'Shopping',
  ENTERTAINMENT: 'Entertainment',
  MEDICAL: 'Health',
  PERSONAL_CARE: 'Health',
  INCOME: 'Income',
  TRANSFER_IN: 'Transfer',
  TRANSFER_OUT: 'Transfer',
  LOAN_PAYMENTS: 'Transfer',
};

export function plaidCategory(t: PlaidTransaction): string {
  const pfc = t.personal_finance_category;
  return (pfc?.detailed && CATEGORY_BY_PFC[pfc.detailed]) || (pfc?.primary && CATEGORY_BY_PFC[pfc.primary]) || 'Other';
}

/**
 * A Plaid transaction as a ledger transaction. Plaid amounts are positive for money out, so
 * the sign is flipped. The description is the bank's name for it; the merchant (which the
 * user may rename later) starts as Plaid's cleaned-up merchant name.
 */
export function mapPlaidTransaction(t: PlaidTransaction): Transaction {
  const description = (t.name || t.merchant_name || '').trim();
  const out: Transaction = {
    id: `${PLAID_PROVIDER.id}-${t.transaction_id}`,
    externalId: t.transaction_id,
    date: t.date,
    description,
    amount: round(-t.amount) + 0,
    category: plaidCategory(t),
    accountId: plaidAccountId(t.account_id),
    pending: t.pending === true,
  };
  const merchant = t.merchant_name?.trim();
  if (merchant) out.merchant = merchant;
  return out;
}

/** A failed call to the local Plaid server. */
export class PlaidApiError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
    this.name = 'PlaidApiError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Call the local Plaid server, turning its `{ error }` payloads and an absent server into {@link PlaidApiError}s. */
export async function plaidRequest<T>(
  path: string, body?: unknown, { fetch: fetchFn = (i, init) => fetch(i, init), base = PLAID_API }: { fetch?: FetchLike; base?: string } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(`${base}${path}`, body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new PlaidApiError('SERVER_UNREACHABLE', 'The local Plaid server is not running. Start it with `npm run plaid-server`.');
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // The Vite proxy answers with an empty 5xx when nothing listens on the server's port.
    throw res.ok
      ? new PlaidApiError('BAD_RESPONSE', 'The local Plaid server sent an unreadable response.', res.status)
      : new PlaidApiError('SERVER_UNREACHABLE', 'The local Plaid server is not running. Start it with `npm run plaid-server`.', res.status);
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } })?.error;
    throw new PlaidApiError(err?.code ?? 'ERROR', err?.message ?? `Plaid server error (HTTP ${res.status}).`, res.status);
  }
  return json as T;
}

const institutionName = (i: PlaidItem['institution']) => i?.name || 'a connected bank';

export interface PlaidProviderOptions {
  fetch?: FetchLike;
  base?: string;
  /** Re-read everything from the start instead of from the saved cursor. */
  reset?: boolean;
}

/**
 * Incremental bank sync through the local Plaid server. One `/sync` call per instance
 * answers every SyncProvider method: added and modified transactions come back from
 * `fetchTransactions` (and merge by Plaid's transaction_id), removed ones from
 * `fetchRemovals`. `since` is ignored; the server keeps Plaid's cursor.
 */
export class PlaidProvider implements RemoteSyncProvider {
  readonly id = PLAID_PROVIDER.id;
  readonly name = PLAID_PROVIDER.name;
  readonly kind = 'remote' as const;
  readonly requiresAuth = true as const;
  readonly description = PLAID_PROVIDER.description;
  /** Things the user should know about a sync that otherwise succeeded, known after it ran. */
  readonly problems: string[] = [];
  private pulled?: Promise<PlaidSyncResponse>;

  constructor(private options: PlaidProviderOptions = {}) {}

  private request<T>(path: string, body?: unknown) {
    return plaidRequest<T>(path, body, this.options);
  }

  status(): Promise<PlaidStatus> {
    return this.request<PlaidStatus>('/status');
  }

  /** A Plaid Link token for connecting a bank. */
  async linkToken(): Promise<string> {
    return (await this.request<{ link_token: string }>('/link-token', {})).link_token;
  }

  /** Hand Link's public token to the server, which keeps the access token; resolves to the new item. */
  exchange(publicToken: string, institution?: { institution_id?: string; name?: string } | null) {
    return this.request<{ item_id: string; institution: PlaidItem['institution'] }>(
      '/exchange', { public_token: publicToken, institution: institution ?? null },
    );
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.status()).items.length > 0;
  }

  private pull(): Promise<PlaidSyncResponse> {
    this.pulled ??= this.request<PlaidSyncResponse>('/sync', this.options.reset ? { reset: true } : {}).then((r) => {
      for (const e of r.errors ?? []) this.problems.push(`${institutionName(e.institution)} could not be synced: ${e.message}`);
      for (const i of r.items ?? []) {
        if (i.transactions_update_status === 'NOT_READY') {
          this.problems.push(`Plaid is still preparing transactions for ${institutionName(i.institution)}; sync again in a minute`);
        }
      }
      return r;
    });
    return this.pulled;
  }

  async listAccounts(): Promise<Account[]> {
    const r = await this.pull();
    const names = new Map((r.items ?? []).map((i) => [i.item_id, i.institution?.name]));
    return r.accounts.map((a) => mapPlaidAccount(a, a.item_id ? names.get(a.item_id) : undefined));
  }

  async fetchTransactions(): Promise<Transaction[]> {
    const r = await this.pull();
    return [...r.added, ...r.modified].map(mapPlaidTransaction);
  }

  async fetchBalances(): Promise<AccountBalance[]> {
    const r = await this.pull();
    return r.accounts.flatMap((a) => {
      const balance = plaidBalance(a);
      return balance === undefined ? [] : [{ accountId: plaidAccountId(a.account_id), balance }];
    });
  }

  async fetchRemovals(): Promise<RemovedTransaction[]> {
    return (await this.pull()).removed.map((r) => ({ externalId: r.transaction_id }));
  }
}
