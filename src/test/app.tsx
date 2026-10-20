/**
 * Helpers for component tests. Import from a test file that runs in jsdom
 * (`// @vitest-environment jsdom`): it installs a fresh fake IndexedDB per test, stubs the
 * browser APIs jsdom lacks and unmounts after each test.
 */
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { IDBFactory } from 'fake-indexeddb';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import App from '../App';
import { openIdbRepository, readLedger, saveLedger } from '../db';
import { emptyLedger } from '../lib/migrate';
import { CsvImportProvider, MockProvider, applySync, fetchSync, type SyncProvider } from '../lib/sync';
import type { LedgerState } from '../lib/types';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('scrollTo', () => {});
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function synced(p: SyncProvider, now = new Date()): Promise<LedgerState> {
  const state = emptyLedger();
  return applySync(state, p.id, await fetchSync(p, state), now).state;
}

/** A ledger holding the demo provider's data, as if "Sync now" had been pressed on `now`. */
export const demoLedger = (now = new Date()) => synced(new MockProvider(now), now);

/** A ledger holding `csv` (date,description,amount[,category] columns) imported into one checking account. */
export const csvLedger = (csv: string) => synced(new CsvImportProvider(csv, {
  mapping: { date: 'date', description: 'description', amount: 'amount', ...(csv.split('\n')[0].includes('category') && { category: 'category' }) },
  accountId: 'everyday',
  newAccount: { id: 'everyday', name: 'Everyday', type: 'checking' },
}));

/** The ledger as currently stored in the (fake) IndexedDB. */
export async function stored(): Promise<LedgerState> {
  const repo = await openIdbRepository();
  try { return (await readLedger(repo))!; } finally { repo.close(); }
}

/** Write `state` to the (fake) IndexedDB the app opens. */
export async function seed(state: LedgerState) {
  const repo = await openIdbRepository();
  await saveLedger(repo, state);
  repo.close();
}

/** Seed the database, open `hash` and render the whole app once the ledger has loaded. */
export async function renderApp(state?: LedgerState, hash = '#/') {
  if (state) await seed(state);
  history.replaceState(null, '', hash);
  const view = render(<App />);
  await waitForLoaded();
  return view;
}

export async function waitForLoaded() {
  await waitFor(() => expect(screen.queryByText('Loading your ledger…')).toBeNull());
}
