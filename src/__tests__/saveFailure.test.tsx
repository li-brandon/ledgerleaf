// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { emptyLedger } from '../lib/migrate';
import { renderApp, stored } from '../test/app';

/** Whether closing the tab now would ask first. */
function closeIsPrevented() {
  const e = new Event('beforeunload', { cancelable: true });
  dispatchEvent(e);
  return e.defaultPrevented;
}

it('shows a banner while saves fail, warns before closing, and saves the edit on retry', async () => {
  const user = userEvent.setup();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  await renderApp(emptyLedger(), '#/settings');
  expect(closeIsPrevented()).toBe(false);

  // Every write fails, as when the browser's storage quota is used up.
  const transaction = IDBDatabase.prototype.transaction;
  const failing = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
    this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>
  ) {
    if (args[1] === 'readwrite') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return transaction.apply(this, args);
  });

  await user.selectOptions(screen.getByRole('combobox', { name: /Currency/ }), 'EUR');
  const alert = await screen.findByRole('alert', {}, { timeout: 2000 });
  expect(alert).toHaveTextContent('Changes not saved');
  expect(alert).toHaveTextContent('The quota has been exceeded.');
  expect(errors).toHaveBeenCalledWith(expect.objectContaining({ name: 'QuotaExceededError' }));
  expect((await stored()).settings?.currency ?? 'USD').toBe('USD');
  expect(closeIsPrevented()).toBe(true);

  // The edit is still in memory, and the banner stays until a save succeeds.
  expect(screen.getByRole('combobox', { name: /Currency/ })).toHaveValue('EUR');
  const attempts = errors.mock.calls.length;
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(errors.mock.calls.length).toBeGreaterThan(attempts));
  expect(screen.getByRole('alert')).toHaveTextContent('Changes not saved');

  failing.mockRestore();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect((await stored()).settings?.currency).toBe('EUR');
  expect(closeIsPrevented()).toBe(false);
});
