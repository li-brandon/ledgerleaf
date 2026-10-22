// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PlaidStatus, PlaidSyncResponse } from '../../lib/sync';
import { PLAID_LINK_SRC, type PlaidLinkFactory } from '../../plaidLink';
import { renderApp, stored } from '../../test/app';

const card = () => screen.getByRole('heading', { name: /Bank via Plaid/ }).closest('section')!;

const item = { item_id: 'item-1', institution: { name: 'First Platypus Bank' }, last_sync: null, last_error: null };
const SYNC: PlaidSyncResponse = {
  items: [item],
  accounts: [{ account_id: 'acc-1', item_id: 'item-1', name: 'Plaid Checking', mask: '0000', type: 'depository', subtype: 'checking', balances: { current: 100 } }],
  added: [{ transaction_id: 't1', account_id: 'acc-1', amount: 4.33, date: '2026-10-01', name: 'Starbucks', merchant_name: 'Starbucks', pending: false }],
  modified: [],
  removed: [],
  errors: [],
};

/** Stub the local Plaid server; `items` is what /status reports, and /exchange adds the item. */
function stubServer(opts: { items?: PlaidStatus['items']; sync?: () => Response } = {}) {
  let items = opts.items ?? [];
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    switch (url) {
      case '/api/plaid/status': return json({ configured: true, env: 'sandbox', items });
      case '/api/plaid/link-token': return json({ link_token: 'link-sandbox-1' });
      case '/api/plaid/exchange':
        expect(JSON.parse(String(init?.body))).toEqual({ public_token: 'public-sandbox-1', institution: { institution_id: 'ins_1', name: 'First Platypus Bank' } });
        items = [item];
        return json({ item_id: 'item-1', institution: item.institution });
      case '/api/plaid/sync': return opts.sync?.() ?? json(SYNC);
      default: return json({ error: { code: 'NOT_FOUND', message: url } }, 404);
    }
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('Plaid connection card', () => {
  it('connects a bank with Plaid Link, then syncs it into the ledger', async () => {
    const fetch = stubServer();
    const create = vi.fn<PlaidLinkFactory['create']>((config) => ({
      open: () => config.onSuccess('public-sandbox-1', { institution: { institution_id: 'ins_1', name: 'First Platypus Bank' } }),
      destroy: () => {},
    }));
    vi.stubGlobal('Plaid', { create });
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');

    const ui = within(card());
    await waitFor(() => expect(ui.getByRole('button', { name: 'Connect a bank' })).toBeEnabled());
    expect(ui.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    await user.click(ui.getByRole('button', { name: 'Connect a bank' }));

    expect(await screen.findByText('Bank via Plaid (sandbox): 1 new of 1 received.')).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ token: 'link-sandbox-1' }));
    expect(fetch.mock.calls.map(([u]) => u)).toEqual(expect.arrayContaining(['/api/plaid/link-token', '/api/plaid/exchange', '/api/plaid/sync']));
    expect(ui.getByText('First Platypus Bank')).toBeInTheDocument();

    const state = await stored();
    expect(state.accounts).toEqual([expect.objectContaining({ id: 'plaid-acc-1', institution: 'First Platypus Bank', balance: 100 })]);
    expect(state.transactions).toEqual([expect.objectContaining({ externalId: 't1', amount: -4.33, merchant: 'Starbucks', source: 'plaid' })]);
    expect(ui.getByText(/^Last synced/)).toBeInTheDocument();
  });

  it('loads the Plaid Link script on demand', async () => {
    stubServer();
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');
    expect(document.querySelector(`script[src="${PLAID_LINK_SRC}"]`)).toBeNull();
    const ui = within(card());
    await waitFor(() => expect(ui.getByRole('button', { name: 'Connect a bank' })).toBeEnabled());
    await user.click(ui.getByRole('button', { name: 'Connect a bank' }));
    const script = await waitFor(() => {
      const s = document.querySelector<HTMLScriptElement>(`script[src="${PLAID_LINK_SRC}"]`);
      expect(s).not.toBeNull();
      return s!;
    });
    script.dispatchEvent(new Event('error'));
    expect(await ui.findByRole('alert')).toHaveTextContent('Could not load Plaid Link');
  });

  it('shows a sync error on the card and keeps the ledger unchanged', async () => {
    stubServer({
      items: [item],
      sync: () => new Response(JSON.stringify({ error: { code: 'ITEM_LOGIN_REQUIRED', message: 'Please reconnect your bank.' } }), { status: 400 }),
    });
    const user = userEvent.setup();
    await renderApp(undefined, '#/connections');
    const ui = within(card());
    await waitFor(() => expect(ui.getByRole('button', { name: 'Sync now' })).toBeEnabled());
    await user.click(ui.getByRole('button', { name: 'Sync now' }));
    expect(await ui.findByRole('alert')).toHaveTextContent('Bank via Plaid (sandbox) failed: Please reconnect your bank.');
    expect((await stored()).transactions).toEqual([]);
  });

  it('explains how to start the server when it is not running', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await renderApp(undefined, '#/connections');
    const ui = within(card());
    expect(await ui.findByText('The local Plaid server is not running. Start it with `npm run plaid-server`.')).toBeInTheDocument();
    expect(ui.getByRole('button', { name: 'Connect a bank' })).toBeDisabled();
    expect(ui.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
