// @vitest-environment jsdom
import { renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { openDB } from 'idb';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DB_NAME, DB_VERSION, openIdbRepository, readLedger, saveLedger } from '../db';
import { emptyLedger } from '../lib/migrate';
import type { LedgerState } from '../lib/types';
import { useLedger } from '../store';
import { renderApp, stored } from '../test/app';

/** Messages the app posts to other tabs. */
let heard: unknown[];
let listener: BroadcastChannel;
beforeEach(() => {
  heard = [];
  listener = new BroadcastChannel(DB_NAME);
  listener.onmessage = (e) => heard.push(e.data);
});
afterEach(() => listener.close());

/** Another tab changes the stored ledger and tells the others. */
async function otherTab(change: (s: LedgerState) => LedgerState) {
  const repo = await openIdbRepository();
  const prev = (await readLedger(repo))!;
  await saveLedger(repo, change(prev), prev);
  repo.close();
  listener.postMessage({ type: 'changed' }); // a channel does not hear its own messages
}

const currency = () => screen.getByRole('combobox', { name: /Currency/ });
const settle = () => new Promise((r) => setTimeout(r, 400)); // longer than the save debounce

it('tells other tabs after saving', async () => {
  const user = userEvent.setup();
  await renderApp(emptyLedger(), '#/settings');
  await user.selectOptions(currency(), 'EUR');
  await waitFor(() => expect(heard).toEqual([{ type: 'changed' }]));
  expect((await stored()).settings?.currency).toBe('EUR');
});

it("shows another tab's changes without reloading, and does not save or announce them again", async () => {
  await renderApp(emptyLedger(), '#/settings');
  await otherTab((s) => ({ ...s, settings: { currency: 'EUR', monthStartDay: 1, theme: 'system' } }));
  await waitFor(() => expect(currency()).toHaveValue('EUR'));
  await settle();
  expect(heard).toEqual([]);
});

it("saves this tab's unsaved edit first, then shows both", async () => {
  const user = userEvent.setup();
  await renderApp(emptyLedger(), '#/settings');
  await user.selectOptions(currency(), 'EUR'); // still waiting for the debounce
  await otherTab((s) => ({ ...s, accounts: [{ id: 'acc-9', name: 'Savings Jar', type: 'savings' }] }));

  await waitFor(async () => expect((await stored()).settings?.currency).toBe('EUR'));
  location.hash = '#/accounts';
  expect(await screen.findByText('Savings Jar')).toBeInTheDocument();
  expect((await stored()).accounts.map((a) => a.id)).toEqual(['acc-9']);
});

it('saves, closes and asks for a reload when another tab upgrades the database', async () => {
  const user = userEvent.setup();
  await renderApp(emptyLedger(), '#/settings');
  await user.selectOptions(currency(), 'EUR');

  const upgraded = await openDB(DB_NAME, DB_VERSION + 1);
  expect(await upgraded.get('meta', 'settings')).toMatchObject({ currency: 'EUR' });
  upgraded.close();
  expect(await screen.findByRole('alert')).toHaveTextContent('Ledgerleaf was updated in another tab. Reload this tab');
  expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
});

it('asks to close other tabs while an upgrade waits for them', async () => {
  (await openIdbRepository()).close();
  const old = await openDB(DB_NAME, DB_VERSION); // an older tab, which ignores the upgrade request
  const { result } = renderHook(() =>
    useLedger((options) => openIdbRepository(DB_NAME, { ...options, version: DB_VERSION + 1 })));

  await waitFor(() => expect(result.current.blocked).toBe(true));
  expect(result.current.loading).toBe(true);
  old.close();
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.blocked).toBe(false);
});
