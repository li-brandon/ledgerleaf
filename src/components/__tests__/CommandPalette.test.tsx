// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { THEME_KEY } from '../../theme';
import { demoLedger, renderApp, stored } from '../../test/app';

const palette = () => screen.queryByRole('dialog', { name: 'Command palette' });
const input = () => screen.getByRole('combobox', { name: 'Search commands' });
const options = () => within(palette()!).queryAllByRole('option').map((o) => o.textContent);
const selected = () => within(palette()!).getByRole('option', { selected: true });

describe('command palette', () => {
  it('opens with Cmd+K and Ctrl+K, takes focus and gives it back on Escape', async () => {
    const user = userEvent.setup();
    await renderApp();
    const before = screen.getByRole('button', { name: 'Load demo data' });
    before.focus();

    await user.keyboard('{Meta>}k{/Meta}');
    expect(palette()).toBeInTheDocument();
    expect(palette()).toHaveAttribute('aria-modal', 'true');
    expect(input()).toHaveFocus();
    expect(input()).toHaveAttribute('aria-activedescendant', selected().id);

    await user.keyboard('{Escape}');
    expect(palette()).toBeNull();
    expect(before).toHaveFocus();

    await user.keyboard('{Control>}k{/Control}');
    expect(palette()).toBeInTheDocument();
    // The shortcut toggles it closed again.
    await user.keyboard('{Control>}k{/Control}');
    expect(palette()).toBeNull();
  });

  it('filters commands and says when nothing matches', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.keyboard('{Control>}k{/Control}');
    expect(options()).toContain('Categories & rulesPage');

    await user.type(input(), 'BUDG');
    expect(options()).toEqual(['BudgetsPage', 'Search transactions for “BUDG”Search']);
    expect(screen.queryByText('No matches')).toBeNull();

    await user.clear(input());
    await user.type(input(), 'zzz');
    expect(screen.getByText('No matches')).toBeInTheDocument();
    expect(options()).toEqual(['Search transactions for “zzz”Search']);
  });

  it('moves with the arrow keys and runs the selection on Enter', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(input(), 'ion');
    expect(options()).toEqual(['TransactionsPage', 'ConnectionsPage', 'Search transactions for “ion”Search']);
    expect(selected()).toHaveTextContent('Transactions');

    await user.keyboard('{ArrowUp}');
    expect(selected()).toHaveTextContent('Search transactions');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(selected()).toHaveTextContent('Connections');
    expect(input()).toHaveAttribute('aria-activedescendant', selected().id);

    await user.keyboard('{Enter}');
    expect(palette()).toBeNull();
    await waitFor(() => expect(location.hash).toBe('#/connections'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Connections' })).toBeInTheDocument();
  });

  it('runs a command when clicked', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.keyboard('{Control>}k{/Control}');
    await user.click(screen.getByRole('option', { name: /Categories & rules/ }));
    await waitFor(() => expect(location.hash).toBe('#/categories'));
    expect(palette()).toBeNull();
  });

  it('searches transactions for the typed text', async () => {
    const user = userEvent.setup();
    await renderApp(await demoLedger());
    await user.keyboard('{Control>}k{/Control}');
    await user.type(input(), 'coffee{ArrowUp}{Enter}');
    await waitFor(() => expect(location.hash).toBe('#/transactions?q=coffee'));
    expect(await screen.findByRole('searchbox')).toHaveValue('coffee');
  });

  it('takes "Import CSV" to the CSV import card on Connections', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(input(), 'import csv{Enter}');
    await waitFor(() => expect(location.hash).toBe('#/connections?import=csv'));
    const card = (await screen.findByRole('heading', { name: /CSV import/ })).closest('section')!;
    await waitFor(() => expect(card).toHaveFocus());
    expect(within(card).getByText('Choose file')).toBeInTheDocument();
  });

  it('switches the theme and saves it', async () => {
    const user = userEvent.setup();
    await renderApp();
    expect(document.documentElement.dataset.theme).toBe('light');

    await user.keyboard('{Control>}k{/Control}');
    await user.type(input(), 'theme: dark{Enter}');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    await waitFor(async () => expect((await stored()).settings?.theme).toBe('dark'));

    await user.keyboard('{Control>}k{/Control}');
    await user.type(input(), 'match system{Enter}');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(localStorage.getItem(THEME_KEY)).toBe('system');
  });
});
