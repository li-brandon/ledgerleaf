// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetPersistenceRequest } from '../browser';
import { renderApp, stored } from '../test/app';

/** Mock `navigator.storage`; `persisted` and `persist` resolve (or reject) as given. */
function mockStorage(persisted: boolean, persist: boolean | Error = false) {
  const s = {
    persisted: vi.fn(() => Promise.resolve(persisted)),
    persist: vi.fn(() => (persist instanceof Error ? Promise.reject(persist) : Promise.resolve(persist))),
  };
  Object.defineProperty(navigator, 'storage', { configurable: true, value: s });
  return s;
}

beforeEach(() => forgetPersistenceRequest());
afterEach(() => {
  delete (navigator as { storage?: unknown }).storage;
});

/** The Storage block in Settings. */
const storageBlock = () => screen.getByRole('heading', { name: 'Storage' }).parentElement!;

describe('Settings storage', () => {
  it('shows persistent storage without a request button', async () => {
    mockStorage(true);
    await renderApp(undefined, '#/settings');
    const ui = within(storageBlock());
    expect(await ui.findByText(/^Persistent — the browser won't clear this data/)).toBeInTheDocument();
    expect(ui.queryByRole('button')).toBeNull();
  });

  it('shows unsupported storage without a request button', async () => {
    expect('storage' in navigator).toBe(false);
    await renderApp(undefined, '#/settings');
    const ui = within(storageBlock());
    expect(await ui.findByText('Not supported by this browser.')).toBeInTheDocument();
    expect(ui.queryByRole('button')).toBeNull();
  });

  it('requests persistent storage and shows the grant', async () => {
    const user = userEvent.setup();
    const s = mockStorage(false, true);
    await renderApp(undefined, '#/settings');
    const ui = within(storageBlock());
    expect(await ui.findByText(/^Best effort — the browser may clear this data/)).toBeInTheDocument();
    await user.click(ui.getByRole('button', { name: 'Request persistent storage' }));
    expect(await ui.findByText(/^Persistent/)).toBeInTheDocument();
    expect(s.persist).toHaveBeenCalledOnce();
    expect(ui.queryByRole('button')).toBeNull();
  });

  it('says so when the browser declines', async () => {
    const user = userEvent.setup();
    const s = mockStorage(false, false);
    await renderApp(undefined, '#/settings');
    const ui = within(storageBlock());
    await user.click(await ui.findByRole('button', { name: 'Request persistent storage' }));
    expect(await ui.findByRole('status')).toHaveTextContent('The browser declined');
    expect(s.persist).toHaveBeenCalledOnce();
    expect(ui.getByText(/^Best effort/)).toBeInTheDocument();
  });
});

const BANK_CSV = 'Date,Description,Amount\n10/13/2026,Corner Grocer,-42.10\n10/02/2026,Paycheck,2500.00';
const csvFile = (text: string, name = 'checking.csv') => new File([text], name, { type: 'text/csv' });
const card = () => screen.getByRole('heading', { name: /CSV import/ }).closest('section')!;

async function importCsv(user: ReturnType<typeof userEvent.setup>, text: string, rows: number, name?: string) {
  await user.upload(card().querySelector<HTMLInputElement>('input[type=file]')!, csvFile(text, name));
  await user.click(await within(card()).findByRole('button', { name: `Import ${rows} rows` }));
  return within(card()).findByRole('status');
}

describe('requesting persistence after an import', () => {
  it('asks once the first import has added data, and not again this session', async () => {
    const user = userEvent.setup();
    const s = mockStorage(false, false);
    await renderApp(undefined, '#/connections');
    expect(s.persist).not.toHaveBeenCalled();

    await importCsv(user, BANK_CSV, 2);
    await waitFor(() => expect(s.persist).toHaveBeenCalledOnce());

    // The browser declined; another import does not ask again.
    await importCsv(user, `${BANK_CSV}\n10/04/2026,Bakery,-6.50`, 3, 'october.csv');
    expect((await stored()).transactions).toHaveLength(3);
    expect(s.persisted).toHaveBeenCalledOnce();
    expect(s.persist).toHaveBeenCalledOnce();
  });

  it('does not ask when storage is already persistent', async () => {
    const user = userEvent.setup();
    const s = mockStorage(true, true);
    await renderApp(undefined, '#/connections');
    await importCsv(user, BANK_CSV, 2);
    await waitFor(() => expect(s.persisted).toHaveBeenCalled());
    expect(s.persist).not.toHaveBeenCalled();
  });

  it('does not ask for demo data', async () => {
    const user = userEvent.setup();
    const s = mockStorage(false, true);
    await renderApp(undefined, '#/');
    await user.click(screen.getByRole('button', { name: 'Load demo data' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /demo data/ })).toBeNull());
    expect(s.persisted).not.toHaveBeenCalled();
  });

  it('still imports when the request fails', async () => {
    const user = userEvent.setup();
    const s = mockStorage(false, new Error('AbortError'));
    await renderApp(undefined, '#/connections');
    const summary = await importCsv(user, BANK_CSV, 2);
    expect(summary).toHaveTextContent('checking.csv imported into');
    await waitFor(() => expect(s.persist).toHaveBeenCalledOnce());
    expect((await stored()).transactions).toHaveLength(2);
  });
});
