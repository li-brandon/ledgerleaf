// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DB_NAME, openIdbRepository, readLedger, saveLedger } from '../db';
import { editTransaction } from '../lib/txEdits';
import type { LedgerState } from '../lib/types';
import { useLedger } from '../store';
import { csvLedger, seed, stored } from '../test/app';

const CSV = 'date,description,amount\n2026-10-01,Tea,-3\n2026-10-02,Rent,-1650';

let listener: BroadcastChannel;
beforeEach(() => {
  listener = new BroadcastChannel(DB_NAME);
});
afterEach(() => listener.close());

async function open() {
  const before = await csvLedger(CSV);
  await seed(before);
  const hook = renderHook(() => useLedger());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return { ...hook, before, tea: before.transactions.find((t) => t.description === 'Tea')! };
}

/** Another tab changes the stored ledger and tells the others. */
async function otherTab(change: (s: LedgerState) => LedgerState) {
  const repo = await openIdbRepository();
  const prev = (await readLedger(repo))!;
  await saveLedger(repo, change(prev), prev);
  repo.close();
  listener.postMessage({ type: 'changed' });
}

it('deletes a transaction and saves it with its tombstone before showing it, then restores it', async () => {
  const { result, before, tea } = await open();
  let deleted;
  await act(async () => { deleted = await result.current.deleteTransaction(tea.id); });
  expect(deleted).toEqual(tea);
  expect(result.current.state.transactions.map((t) => t.description)).toEqual(['Rent']);
  const after = await stored();
  expect(after.transactions.map((t) => t.description)).toEqual(['Rent']);
  expect(after.deletedTransactions).toEqual([expect.objectContaining({ id: tea.id, source: 'csv', externalId: tea.externalId })]);

  await act(() => result.current.restoreTransaction(tea));
  expect(result.current.state.transactions).toEqual(before.transactions);
  expect((await stored()).transactions).toEqual(before.transactions);
  expect((await stored()).deletedTransactions).toBeUndefined();
});

it('changes nothing and throws when the delete or the restore cannot be saved', async () => {
  const { result, before, tea } = await open();
  const fail = () => vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementationOnce(() => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  });
  const rent = before.transactions.find((t) => t.description === 'Rent')!.id;
  fail();
  act(() => result.current.editTransaction(rent, { notes: 'October' })); // queued, not saved yet
  await act(() => expect(result.current.deleteTransaction(tea.id)).rejects.toThrow('The transaction could not be deleted; nothing was changed.'));
  expect(result.current.state.transactions.map((t) => t.description)).toEqual(['Rent', 'Tea']);
  expect((await stored()).deletedTransactions).toBeUndefined();
  // The edit queued before the failed delete is still saved.
  await waitFor(async () => expect((await stored()).transactions.find((t) => t.id === rent)?.notes).toBe('October'));
  expect((await stored()).transactions.map((t) => t.description)).toEqual(['Rent', 'Tea']);

  await act(() => result.current.deleteTransaction(tea.id));
  // Restoring forgets the tombstone, a meta delete.
  fail();
  await act(() => expect(result.current.restoreTransaction(tea)).rejects.toThrow('The transaction could not be restored; nothing was changed.'));
  expect(result.current.state.transactions.map((t) => t.description)).toEqual(['Rent']);
  expect((await stored()).deletedTransactions).toHaveLength(1);
});

it("restores against the latest ledger, keeping another tab's edit made after the delete", async () => {
  const { result, tea } = await open();
  await act(() => result.current.deleteTransaction(tea.id));
  const rent = result.current.state.transactions[0].id;
  await otherTab((s) => editTransaction(s, rent, { notes: 'October' }));
  await waitFor(() => expect(result.current.state.transactions[0].notes).toBe('October'));

  await act(() => result.current.restoreTransaction(tea));
  await act(() => result.current.restoreTransaction(tea)); // a second undo is a no-op
  const after = await stored();
  expect(after.transactions.map((t) => [t.description, t.notes])).toEqual([['Rent', 'October'], ['Tea', undefined]]);
  expect(result.current.state.transactions).toEqual(after.transactions);
});

it('keeps an edit made while the delete is being saved', async () => {
  const { result, tea } = await open();
  const rent = result.current.state.transactions.find((t) => t.description === 'Rent')!.id;
  await act(async () => {
    const deleting = result.current.deleteTransaction(tea.id);
    result.current.editTransaction(rent, { notes: 'October' });
    await deleting;
  });
  expect(result.current.state.transactions.map((t) => [t.description, t.notes])).toEqual([['Rent', 'October']]);
  await waitFor(async () => expect((await stored()).transactions.map((t) => [t.description, t.notes])).toEqual([['Rent', 'October']]));
});
