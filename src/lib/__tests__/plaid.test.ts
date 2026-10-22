import { describe, expect, it, vi } from 'vitest';
import { categoryId } from '../categories';
import { emptyLedger } from '../migrate';
import {
  PlaidApiError, PlaidProvider, SyncError, applySync, fetchSync, mapPlaidAccount, mapPlaidTransaction, mergeSync,
  plaidBalance, type PlaidAccount, type PlaidSyncResponse, type PlaidTransaction,
} from '../sync';
import { editTransaction, setCategory, setReviewed } from '../txEdits';
import type { LedgerState, Transaction } from '../types';

const now = new Date(2026, 9, 21);

const checking: PlaidAccount = {
  account_id: 'acc-chk', item_id: 'item-1', name: 'Plaid Checking', mask: '0000', type: 'depository', subtype: 'checking',
  balances: { current: 110, available: 100, iso_currency_code: 'USD' },
};
const card: PlaidAccount = {
  account_id: 'acc-cc', item_id: 'item-1', name: 'Plaid Credit Card', mask: '3333', type: 'credit', subtype: 'credit card',
  balances: { current: 410, available: null, iso_currency_code: 'USD' },
};

const ptx = (id: string, over: Partial<PlaidTransaction> = {}): PlaidTransaction => ({
  transaction_id: id, account_id: 'acc-chk', amount: 12.5, date: '2026-10-01', name: `SQ *SHOP ${id}`, merchant_name: 'Shop',
  pending: false, personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_OTHER' }, ...over,
});

const response = (over: Partial<PlaidSyncResponse> = {}): PlaidSyncResponse => ({
  items: [{ item_id: 'item-1', institution: { id: 'ins_1', name: 'First Platypus Bank' }, last_sync: null, last_error: null }],
  accounts: [checking, card], added: [], modified: [], removed: [], errors: [], ...over,
});

/** A fake local Plaid server answering /sync with each response in turn. */
function server(...responses: (PlaidSyncResponse | { status: number; error: { code: string; message: string } })[]) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('/api/plaid/sync');
    expect(init?.method).toBe('POST');
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    return 'status' in next
      ? new Response(JSON.stringify({ error: next.error }), { status: next.status })
      : new Response(JSON.stringify(next), { status: 200 });
  });
  return { fetch, provider: () => new PlaidProvider({ fetch }) };
}

async function syncOnce(state: LedgerState, p: PlaidProvider) {
  return applySync(state, p.id, await fetchSync(p, state), now);
}

const byExternal = (s: LedgerState, id: string) => s.transactions.find((t) => t.externalId === id)!;

describe('Plaid mapping', () => {
  it('flips Plaid amounts (positive = money out) into the ledger convention', () => {
    expect(mapPlaidTransaction(ptx('a', { amount: 12.5 })).amount).toBe(-12.5);
    expect(mapPlaidTransaction(ptx('b', { amount: -2500 })).amount).toBe(2500);
    expect(Object.is(mapPlaidTransaction(ptx('c', { amount: 0 })).amount, 0)).toBe(true);
    expect(mapPlaidTransaction(ptx('d', { amount: 0.1 + 0.2 })).amount).toBe(-0.3);
  });

  it('keeps the transaction id, date, pending flag, merchant and account', () => {
    expect(mapPlaidTransaction(ptx('t1', { pending: true }))).toEqual({
      id: 'plaid-t1', externalId: 't1', date: '2026-10-01', description: 'SQ *SHOP t1', merchant: 'Shop', amount: -12.5,
      category: 'Shopping', accountId: 'plaid-acc-chk', pending: true,
    });
    const noMerchant = mapPlaidTransaction(ptx('t2', { merchant_name: null, name: 'ATM WITHDRAWAL' }));
    expect(noMerchant.description).toBe('ATM WITHDRAWAL');
    expect('merchant' in noMerchant).toBe(false);
    expect(mapPlaidTransaction(ptx('t3', { name: null, merchant_name: 'Uber' })).description).toBe('Uber');
  });

  it('maps personal finance categories, preferring the detailed one', () => {
    const cat = (primary: string, detailed?: string) =>
      mapPlaidTransaction(ptx('x', { personal_finance_category: { primary, detailed } })).category;
    expect(cat('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES')).toBe('Groceries');
    expect(cat('FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE')).toBe('Dining');
    expect(cat('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT')).toBe('Rent');
    expect(cat('TRANSFER_OUT')).toBe('Transfer');
    expect(cat('BANK_FEES')).toBe('Other');
    expect(mapPlaidTransaction(ptx('y', { personal_finance_category: null })).category).toBe('Other');
  });

  it('maps account types and reports owed balances as negative', () => {
    expect(mapPlaidAccount(checking, 'First Platypus Bank')).toEqual({
      id: 'plaid-acc-chk', name: 'Plaid Checking ••0000', type: 'checking', currency: 'USD', institution: 'First Platypus Bank', balance: 110,
    });
    expect(mapPlaidAccount(card)).toMatchObject({ type: 'credit', balance: -410 });
    expect(mapPlaidAccount({ ...checking, subtype: 'savings' }).type).toBe('savings');
    expect(mapPlaidAccount({ ...checking, type: 'loan' })).toMatchObject({ type: 'loan', balance: -110 });
    expect(mapPlaidAccount({ ...checking, type: 'investment' }).type).toBe('investment');
    expect(plaidBalance({ ...checking, balances: { current: null, available: 55 } })).toBe(55);
    expect(plaidBalance({ ...checking, balances: {} })).toBeUndefined();
    expect('balance' in mapPlaidAccount({ ...checking, mask: null, balances: undefined })).toBe(false);
  });
});

describe('PlaidProvider sync', () => {
  it('adds accounts, balances and transactions from one /sync call', async () => {
    const { fetch, provider } = server(response({ added: [ptx('t1'), ptx('t2', { account_id: 'acc-cc', amount: 40, pending: true })] }));
    const { state, added, received } = await syncOnce(emptyLedger(), provider());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect({ added, received }).toEqual({ added: 2, received: 2 });
    expect(state.accounts.map((a) => [a.id, a.institution, a.balance, a.source])).toEqual([
      ['plaid-acc-chk', 'First Platypus Bank', 110, 'plaid'],
      ['plaid-acc-cc', 'First Platypus Bank', -410, 'plaid'],
    ]);
    expect(byExternal(state, 't2')).toMatchObject({ amount: -40, pending: true, accountId: 'plaid-acc-cc', source: 'plaid', reviewed: false });
    expect(state.balanceSnapshots).toEqual(expect.arrayContaining([
      { accountId: 'plaid-acc-cc', date: '2026-10-21', balance: -410, source: 'plaid' },
    ]));
    expect(state.syncs?.plaid?.lastSync).toBe(now.toISOString());
  });

  it('updates bank fields on modified transactions but keeps user edits and rule results', async () => {
    const rule = { id: 'r1', merchantContains: 'shop', categoryId: categoryId('Groceries'), renameMerchant: 'Corner Shop' };
    const base = { ...emptyLedger(), rules: [rule] };
    const first = await syncOnce(base, server(response({ added: [ptx('t1'), ptx('t2'), ptx('t3', { pending: true })] })).provider());
    // The rule ran on arrival.
    expect(byExternal(first.state, 't1')).toMatchObject({ merchant: 'Corner Shop', category: 'Groceries' });

    let s = setCategory(first.state, [byExternal(first.state, 't2').id], 'Health');
    s = editTransaction(s, byExternal(s, 't2').id, { notes: 'prescription', merchant: 'Pharmacy' });
    s = setReviewed(s, [byExternal(s, 't2').id], true);

    const modified = [
      ptx('t1', { amount: 13, name: 'SQ *SHOP T1 FINAL', merchant_name: 'Other Shop', personal_finance_category: { primary: 'TRAVEL' } }),
      ptx('t2', { amount: 20, date: '2026-10-02' }),
      ptx('t3', { pending: false }),
    ];
    const second = await syncOnce(s, server(response({ modified })).provider());
    expect({ added: second.added, updated: second.updated, removed: second.removed }).toEqual({ added: 0, updated: 3, removed: 0 });

    const t1 = byExternal(second.state, 't1');
    expect(t1).toMatchObject({ amount: -13, description: 'SQ *SHOP T1 FINAL', merchant: 'Corner Shop', category: 'Groceries' });
    const t2 = byExternal(second.state, 't2');
    expect(t2).toMatchObject({
      amount: -20, date: '2026-10-02', category: 'Health', categoryEdited: true, notes: 'prescription', merchant: 'Pharmacy',
      merchantEdited: true, reviewed: true,
    });
    expect(byExternal(second.state, 't3').pending).toBe(false);
    expect(second.state.transactions).toHaveLength(3);
  });

  it('deletes removed transactions, only from Plaid', async () => {
    const csvTwin: Transaction = {
      id: 'csv-t1', externalId: 't1', source: 'csv', date: '2026-10-01', description: 'x', amount: -1, category: 'Other', accountId: 'csv-a',
    };
    const base = { ...emptyLedger(), accounts: [{ id: 'csv-a', name: 'CSV', type: 'checking' as const }], transactions: [csvTwin] };
    const first = await syncOnce(base, server(response({ added: [ptx('t1'), ptx('t2')] })).provider());
    expect(first.state.transactions).toHaveLength(3);

    const second = await syncOnce(first.state, server(response({
      removed: [{ transaction_id: 't1', account_id: 'acc-chk' }, { transaction_id: 'never-seen' }],
    })).provider());
    expect(second.removed).toBe(1);
    expect(second.state.transactions.map((t) => t.id).sort()).toEqual(['csv-t1', 'plaid-t2']);
  });

  it('applies removals after additions in the same response', async () => {
    const r = await syncOnce(emptyLedger(), server(response({ added: [ptx('t1')], removed: [{ transaction_id: 't1' }] })).provider());
    expect({ added: r.added, removed: r.removed, count: r.state.transactions.length }).toEqual({ added: 1, removed: 1, count: 0 });
  });

  it('is idempotent: replaying the same response changes nothing', async () => {
    const res = response({ added: [ptx('t1'), ptx('t2')], modified: [ptx('t0', { amount: 3 })], removed: [{ transaction_id: 'gone' }] });
    const first = await syncOnce(emptyLedger(), server(res).provider());
    const again = await syncOnce(first.state, server(res).provider());
    expect({ added: again.added, updated: again.updated, removed: again.removed }).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(again.state.transactions).toHaveLength(3);
    again.state.transactions.forEach((t, i) => expect(t).toEqual(first.state.transactions[i]));

    // Directly in mergeSync, unchanged records keep their reference.
    const incoming = await fetchSync(server(res).provider(), first.state);
    const merged = mergeSync(first.state, incoming);
    merged.transactions.forEach((t) => expect(first.state.transactions).toContain(t));
  });

  it('reports items that failed or are not ready yet as problems', async () => {
    const p = server(response({
      items: [{ item_id: 'item-1', institution: { name: 'First Platypus Bank' }, last_sync: null, last_error: null, transactions_update_status: 'NOT_READY' }],
      errors: [{ item_id: 'item-2', institution: { name: 'Tattersall FCU' }, code: 'ITEM_LOGIN_REQUIRED', message: 'Please reconnect your bank.' }],
    })).provider();
    await syncOnce(emptyLedger(), p);
    expect(p.problems).toEqual([
      'Tattersall FCU could not be synced: Please reconnect your bank.',
      'Plaid is still preparing transactions for First Platypus Bank; sync again in a minute',
    ]);
  });

  it('fails the whole sync, leaving the ledger alone, when the server reports an error or is down', async () => {
    const failing = server({ status: 400, error: { code: 'ITEM_LOGIN_REQUIRED', message: 'Please reconnect your bank.' } }).provider();
    await expect(fetchSync(failing, emptyLedger())).rejects.toThrow(new SyncError('plaid', 'Bank via Plaid (sandbox) failed: Please reconnect your bank.'));

    const down = new PlaidProvider({ fetch: async () => { throw new TypeError('fetch failed'); } });
    await expect(fetchSync(down, emptyLedger())).rejects.toThrow(/local Plaid server is not running/);

    // The Vite proxy answers 502 with an empty body when the server is not running.
    const proxied = new PlaidProvider({ fetch: async () => new Response('', { status: 502 }) });
    await expect(proxied.status()).rejects.toMatchObject({ code: 'SERVER_UNREACHABLE' });
    await expect(proxied.status()).rejects.toBeInstanceOf(PlaidApiError);
  });

  it('rejects malformed removals', async () => {
    const bad = server({ ...response(), removed: [{ transaction_id: '' }] }).provider();
    await expect(fetchSync(bad, emptyLedger())).rejects.toThrow(/removed transaction #1 has no id/);
  });

  it('talks to the link-token, exchange and status endpoints', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      const body = url.endsWith('/link-token') ? { link_token: 'link-1' }
        : url.endsWith('/exchange') ? { item_id: 'item-1', institution: { name: 'Bank' } }
          : { configured: true, env: 'sandbox', items: [{ item_id: 'item-1', institution: null, last_sync: null, last_error: null }] };
      return new Response(JSON.stringify(body));
    };
    const p = new PlaidProvider({ fetch });
    expect(await p.linkToken()).toBe('link-1');
    expect(await p.exchange('public-1', { institution_id: 'ins_1', name: 'Bank' })).toEqual({ item_id: 'item-1', institution: { name: 'Bank' } });
    expect(await p.isAuthenticated()).toBe(true);
    expect(calls.map(([u, i]) => [u, i?.method, i?.body])).toEqual([
      ['/api/plaid/link-token', 'POST', '{}'],
      ['/api/plaid/exchange', 'POST', JSON.stringify({ public_token: 'public-1', institution: { institution_id: 'ins_1', name: 'Bank' } })],
      ['/api/plaid/status', 'GET', undefined],
    ]);
  });
});
