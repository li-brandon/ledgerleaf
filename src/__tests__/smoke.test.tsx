// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ROUTES, SUBPAGES, routeHref, routeLabel } from '../lib/routes';
import { renderApp } from '../test/app';

it('loads demo data and renders every page without errors', async () => {
  const errors = vi.spyOn(console, 'error');
  const fetch = vi.spyOn(globalThis, 'fetch');
  await renderApp();

  await userEvent.click(screen.getByRole('button', { name: 'Load demo data' }));
  await waitFor(() => expect(screen.queryByText('Your ledger is blank')).toBeNull());
  // The review badge counts the demo transactions.
  expect(within(screen.getByRole('navigation', { name: 'Main' })).getByText(/to review/)).toBeInTheDocument();

  for (const { id } of [...ROUTES, ...SUBPAGES]) {
    await act(async () => { location.hash = routeHref(id); });
    await waitFor(() => expect(document.title).toBe(`${routeLabel(id)} · Ledgerleaf`));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(routeLabel(id));
    expect(screen.queryByText('Your ledger is blank'), id).toBeNull();
    expect(screen.queryByRole('alert'), id).toBeNull();
  }
  expect(errors).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
