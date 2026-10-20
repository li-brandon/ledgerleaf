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
import { openIdbRepository, saveLedger } from '../db';
import { emptyLedger } from '../lib/migrate';
import { MockProvider, applySync, fetchSync } from '../lib/sync';
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

/** A ledger holding the demo provider's data, as if "Sync now" had been pressed on `now`. */
export async function demoLedger(now = new Date()): Promise<LedgerState> {
  const state = emptyLedger();
  const p = new MockProvider(now);
  return applySync(state, p.id, await fetchSync(p, state), now).state;
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
